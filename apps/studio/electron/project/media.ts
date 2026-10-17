import { createHash } from "node:crypto";

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Effect, FileSystem, Semaphore } from "effect";

import { songFileName } from "../../src/lib/file-names";
import {
  DiskFull,
  type FileError,
  FileNotFound,
  FileSystemFailure,
  mapFileError,
  PermissionDenied,
  quoted,
} from "../errors";
import { orDiskFull, type ProjectDb, type Queryable } from "./database";
import { analysis, MEDIA_ROLES, MEDIA_SOURCES, media, mediaChunks, song } from "./schema";

/** Media is stored in chunks of this many bytes; only a file's last chunk is shorter. */
export const CHUNK_SIZE = 1024 * 1024;

export type MediaRole = (typeof MEDIA_ROLES)[number];
export type MediaSource = (typeof MEDIA_SOURCES)[number];

export type MediaRow = typeof media.$inferSelect;

const MIME_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  weba: "audio/webm",
  webm: "video/webm",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  divx: "video/x-msvideo",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
};

/** What a MIME type may look like: header values are Latin-1, and a type is two tokens. */
const MIME_TYPE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/;

/** `mime` if it can go into a `Content-Type` header, else raw bytes. */
export function headerMime(mime: string): string {
  return MIME_TYPE.test(mime) ? mime : "application/octet-stream";
}

/** The MIME type for a media file name, by extension. */
export function mimeFor(fileName: string, role: MediaRole): string {
  const dot = fileName.lastIndexOf(".");
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  const known = MIME_TYPES[extension];
  if (known) return role === "video" || !known.startsWith("video/webm") ? known : "audio/webm";
  if (role === "cover" || role === "background" || !extension) return "application/octet-stream";
  return headerMime(`${role === "video" ? "video" : "audio"}/${extension}`);
}

export interface MediaInput {
  /** The file to copy in, read as is. */
  path: string;
  role: MediaRole;
  fileName: string;
  source: MediaSource;
}

/**
 * Copies a file into the project byte for byte, in 1 MiB chunks, inside one transaction.
 * `onProgress` gets the bytes written so far after each chunk.
 */
export function writeMedia(
  db: ProjectDb,
  input: MediaInput,
  onProgress: (written: number) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<MediaRow, FileError, FileSystem.FileSystem> {
  const toFileError = mapFileError(quoted(input.fileName), "read");
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* toFileError(fs.open(input.path, { flag: "r" }));
        /** The next chunk: full-sized unless the file ends first. */
        const nextChunk = Effect.gen(function* () {
          const buffer = new Uint8Array(CHUNK_SIZE);
          let filled = 0;
          while (filled < CHUNK_SIZE) {
            const read = yield* toFileError(file.read(buffer.subarray(filled)));
            if (read === 0) break;
            filled += read;
          }
          return buffer.subarray(0, filled);
        });
        return yield* keepFileErrors(
          db.transaction((tx) =>
            Effect.gen(function* () {
              const [row] = yield* tx
                .insert(media)
                .values({
                  role: input.role,
                  fileName: input.fileName,
                  mime: mimeFor(input.fileName, input.role),
                  size: 0,
                  sha256: "",
                  source: input.source,
                  createdAt: new Date().toISOString(),
                })
                .returning();
              const hash = createHash("sha256");
              let size = 0;
              for (let index = 0; ; index++) {
                const data = yield* nextChunk;
                if (data.length === 0) break;
                hash.update(data);
                size += data.length;
                yield* tx.insert(mediaChunks).values({ mediaId: row!.id, index, data: Buffer.from(data) });
                yield* onProgress(size);
                if (data.length < CHUNK_SIZE) break;
              }
              const [updated] = yield* tx
                .update(media)
                .set({ size, sha256: hash.digest("hex") })
                .where(eq(media.id, row!.id))
                .returning();
              return updated!;
            }),
          ),
        );
      }),
    );
  });
}

/** Keeps typed file errors, turns a full disk into `DiskFull`, and everything else into a defect. */
function keepFileErrors<A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, FileError, R> {
  return Effect.catch(effect, (error) => (isFileError(error) ? Effect.fail(error) : orDiskFull(Effect.fail(error))));
}

function isFileError(error: unknown): error is FileError {
  return (
    error instanceof FileNotFound ||
    error instanceof PermissionDenied ||
    error instanceof DiskFull ||
    error instanceof FileSystemFailure
  );
}

/** What the project's files are named after: "Artist - Title", as an export names them. */
export function mediaBaseName(db: Queryable): Effect.Effect<string> {
  return Effect.map(
    db.select({ title: song.title, artist: song.artist }).from(song).limit(1).pipe(Effect.orDie),
    ([details]) => songFileName(details?.artist ?? "", details?.title ?? ""),
  );
}

/** Each open project's lock for replacing its media. */
const locks = new WeakMap<object, Semaphore.Semaphore>();
function lockFor(db: ProjectDb): Semaphore.Semaphore {
  let lock = locks.get(db);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    locks.set(db, lock);
  }
  return lock;
}

/** Runs `effect` as the project's only change to its media at the time. */
export function withMediaLock<A, E, R>(db: ProjectDb, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  return lockFor(db).withPermits(1)(effect);
}

/**
 * `effect` as one transaction, nested ones inside it included (as savepoints): typed failures stay as they are, the
 * database's own become a full disk or a defect.
 */
export function inTransaction<A, E, R>(
  db: ProjectDb,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DiskFull, R> {
  return db.transaction(() => effect).pipe(Effect.catchTag("SqlError", (error) => orDiskFull(Effect.fail(error))));
}

/**
 * Makes `input` the project's only file of its role, or removes the role's files (null): the new file goes in, then
 * every other one of the role (their chunks with them, and what was worked out from them), all in one transaction, so a
 * failure or a crash leaves the old file. Run it under `withMediaLock`, or use `replaceRole`.
 */
export function putRole(
  db: ProjectDb,
  role: MediaRole,
  input: Omit<MediaInput, "role"> | null,
): Effect.Effect<MediaRow | null, FileError, FileSystem.FileSystem> {
  return inTransaction(
    db,
    Effect.gen(function* () {
      const added = input ? yield* writeMedia(db, { ...input, role }) : null;
      yield* db
        .delete(media)
        .where(added ? and(eq(media.role, role), ne(media.id, added.id)) : eq(media.role, role))
        .pipe(orDiskFull);
      // The sung pitch and waveform of files that are gone only take up space (the lyrics stay, whatever song they
      // came with).
      yield* db
        .delete(analysis)
        .where(and(isNull(analysis.inputMediaId), inArray(analysis.kind, ["pitch", "waveform"])))
        .pipe(orDiskFull);
      return added;
    }),
  );
}

/** `putRole` as one change at a time per project. */
export function replaceRole(
  db: ProjectDb,
  role: MediaRole,
  input: Omit<MediaInput, "role"> | null,
): Effect.Effect<MediaRow | null, FileError, FileSystem.FileSystem> {
  return withMediaLock(db, putRole(db, role, input));
}

/** Every media row, in the order it was added. */
export function listMedia(db: Queryable): Effect.Effect<MediaRow[]> {
  return db.select().from(media).orderBy(media.id).pipe(Effect.orDie);
}

export function getMedia(db: Queryable, id: number): Effect.Effect<MediaRow | undefined> {
  return db
    .select()
    .from(media)
    .where(eq(media.id, id))
    .pipe(
      Effect.map((rows) => rows[0]),
      Effect.orDie,
    );
}

/** Chunk `index` of a media file, or undefined past its end. */
export function readChunk(db: Queryable, mediaId: number, index: number): Effect.Effect<Uint8Array | undefined> {
  return db
    .select({ data: mediaChunks.data })
    .from(mediaChunks)
    .where(and(eq(mediaChunks.mediaId, mediaId), eq(mediaChunks.index, index)))
    .pipe(
      Effect.map((rows) => rows[0]?.data),
      Effect.orDie,
    );
}

/**
 * Reads bytes `start` to `end` (inclusive) of a media file, one chunk at a time, calling `emit`
 * with each piece. Only the chunks the range touches are read.
 */
export function readRange(
  db: Queryable,
  mediaId: number,
  start: number,
  end: number,
  emit: (bytes: Uint8Array) => Effect.Effect<void>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let index = Math.floor(start / CHUNK_SIZE); index <= Math.floor(end / CHUNK_SIZE); index++) {
      const chunk = yield* readChunk(db, mediaId, index);
      if (!chunk) return;
      const offset = index * CHUNK_SIZE;
      yield* emit(chunk.subarray(Math.max(0, start - offset), Math.min(chunk.length, end - offset + 1)));
    }
  });
}

/** Writes a media file's bytes to `path`, exactly as stored. */
export function writeMediaToFile(
  db: Queryable,
  row: MediaRow,
  path: string,
): Effect.Effect<void, FileError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path, { flag: "wx" }).pipe(mapFileError(quoted(row.fileName), "export"));
        for (let index = 0; ; index++) {
          const chunk = yield* readChunk(db, row.id, index);
          if (!chunk) break;
          yield* file.writeAll(chunk).pipe(mapFileError(quoted(row.fileName), "export"));
        }
        yield* file.sync.pipe(mapFileError(quoted(row.fileName), "export"));
      }),
    );
  });
}

/** Total stored bytes of every chunk of a media file (for checks). */
export function storedSize(db: Queryable, mediaId: number): Effect.Effect<number> {
  return db
    .select({ size: sql<number>`coalesce(sum(length(${mediaChunks.data})), 0)` })
    .from(mediaChunks)
    .where(eq(mediaChunks.mediaId, mediaId))
    .pipe(
      Effect.map((rows) => Number(rows[0]?.size ?? 0)),
      Effect.orDie,
    );
}
