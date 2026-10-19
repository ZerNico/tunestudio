import { Effect, FileSystem, Option, Schema } from "effect";

import type { ProjectOverview } from "../../src/lib/native/types";
import { mediaUrl } from "../protocols/media-url";
import type { StoredRecent } from "../services/recents";
import { readChart, readSong } from "./chart";
import { readMeta } from "./database";
import { readLyrics } from "./lyrics";
import { listMedia, readChunk, withMediaLock } from "./media";
import type { ProjectSession } from "./projects";
import { ImportWarnings } from "./schema";

const decodeWarnings = Schema.decodeUnknownEffect(ImportWarnings);

/** Everything the project screen shows about an open project. */
export function projectOverview(session: ProjectSession) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const chart = yield* readChart(session.db);
    const meta = yield* readMeta(session.db);
    const media = yield* listMedia(session.db);
    const info = yield* fs.stat(session.path).pipe(Effect.option);

    const notes = chart.singers.flatMap((singer) => singer.lines.flatMap((line) => line.notes));
    const starts = notes.map((note) => note.start);
    const ends = notes.map((note) => note.start + note.duration);
    const importWarnings = meta.import_warnings
      ? yield* decodeWarnings(meta.import_warnings).pipe(Effect.orElseSucceed(() => []))
      : [];

    return {
      id: session.id,
      path: session.path,
      fileSize: Option.match(info, { onNone: () => 0, onSome: (value) => Number(value.size) }),
      createdAt: meta.created_at ?? "",
      song: chart.song,
      singers: chart.singers.map((singer) => ({
        index: singer.index,
        name: singer.name,
        lines: singer.lines.length,
        notes: singer.lines.reduce((sum, line) => sum + line.notes.length, 0),
      })),
      lines: chart.singers.reduce((sum, singer) => sum + singer.lines.length, 0),
      notes: notes.length,
      goldenNotes: notes.filter((note) => note.type === "golden" || note.type === "golden-rap").length,
      chartStart: starts.length > 0 ? Math.min(...starts) : null,
      chartEnd: ends.length > 0 ? Math.max(...ends) : null,
      media: media.map((row) => ({
        id: row.id,
        role: row.role,
        fileName: row.fileName,
        mime: row.mime,
        size: row.size,
        duration: row.duration,
        url: mediaUrl(session.id, row.id),
      })),
      importWarnings: [...importWarnings],
      importedFrom: meta.imported_from ?? null,
      lyrics: yield* readLyrics(session.db),
    } satisfies ProjectOverview;
  });
}

/**
 * The overview after a change to the media, read while no other change to them runs: replies to changes made one after
 * the other never come with an older media list than the reply before.
 */
export function overviewAfterMediaChange(session: ProjectSession) {
  return withMediaLock(session.db, projectOverview(session));
}

/** Covers larger than this get no thumbnail. */
const THUMBNAIL_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The project's details for the recent projects list, with a thumbnail of its cover. The thumbnail of `previous` (the
 * project's entry so far) is kept while the cover is the same file.
 */
export function recentEntry(
  session: ProjectSession,
  thumbnail: (image: Uint8Array) => Effect.Effect<string | null>,
  previous?: StoredRecent,
) {
  return Effect.gen(function* () {
    const { songRow } = yield* readSong(session.db);
    const cover = (yield* listMedia(session.db)).find((row) => row.role === "cover");
    let image: string | null = null;
    if (cover && previous?.coverSha256 === cover.sha256) image = previous.cover ?? null;
    else if (cover && cover.size <= THUMBNAIL_MAX_BYTES) image = yield* thumbnail(yield* readAll(session, cover.id));
    return {
      path: session.path,
      title: songRow.title || "Untitled",
      artist: songRow.artist || "Unknown artist",
      lastOpened: new Date().toISOString(),
      ...(image ? { cover: image } : {}),
      ...(cover ? { coverSha256: cover.sha256 } : {}),
    } satisfies StoredRecent;
  });
}

function readAll(session: ProjectSession, mediaId: number) {
  return Effect.gen(function* () {
    const parts: Uint8Array[] = [];
    for (let index = 0; ; index++) {
      const chunk = yield* readChunk(session.db, mediaId, index);
      if (!chunk) break;
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  });
}
