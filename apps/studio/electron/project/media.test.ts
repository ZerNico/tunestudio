import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { FileNotFound } from "../errors";
import { syntheticBytes, tempDir } from "../testing";
import { readF32Analysis, writeF32Analysis } from "./analysis-store";
import { createDatabase, type ProjectDb } from "./database";
import {
  CHUNK_SIZE,
  inTransaction,
  listMedia,
  mimeFor,
  putRole,
  readRange,
  storedSize,
  writeMedia,
  writeMediaToFile,
} from "./media";

let cleanup = () => {};
afterEach(() => cleanup());

/** Runs `use` with an empty project database in a temp folder. */
function withProject<A, E>(use: (db: ProjectDb, dir: string) => Effect.Effect<A, E, NodeServices.NodeServices>) {
  const made = tempDir();
  cleanup = made.cleanup;
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(createDatabase(path.join(made.dir, "p.tunestudio"), "p.tunestudio", "1", "id"), (db) =>
        use(db, made.dir),
      ),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

const SIZES = [0, 1, 1000, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, Math.round(2.5 * CHUNK_SIZE)];

describe("media chunks", () => {
  it("round-trips files of every size byte for byte, with size and SHA-256", async () => {
    await withProject((db, dir) =>
      Effect.gen(function* () {
        for (const [seed, size] of SIZES.entries()) {
          const bytes = syntheticBytes(size, seed + 1);
          const source = path.join(dir, `in-${size}.mp3`);
          fs.writeFileSync(source, bytes);
          const progress: number[] = [];
          const row = yield* writeMedia(
            db,
            { path: source, role: "audio", fileName: `Song ${size}.mp3`, source: "imported" },
            (written) => Effect.sync(() => void progress.push(written)),
          );
          expect(row).toMatchObject({
            size,
            role: "audio",
            fileName: `Song ${size}.mp3`,
            mime: "audio/mpeg",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
          expect(yield* storedSize(db, row.id)).toBe(size);
          expect(progress).toEqual(
            Array.from({ length: Math.ceil(size / CHUNK_SIZE) }, (_, index) =>
              Math.min(size, (index + 1) * CHUNK_SIZE),
            ),
          );

          const out = path.join(dir, `out-${size}.mp3`);
          yield* writeMediaToFile(db, row, out);
          expect(fs.readFileSync(out).equals(bytes)).toBe(true);
        }
        expect((yield* listMedia(db)).map((row) => row.size)).toEqual(SIZES);
      }),
    );
  });

  it("reads any byte range, touching only the chunks it needs", async () => {
    await withProject((db, dir) =>
      Effect.gen(function* () {
        const bytes = syntheticBytes(3 * CHUNK_SIZE + 17, 9);
        const source = path.join(dir, "video.mp4");
        fs.writeFileSync(source, bytes);
        const row = yield* writeMedia(db, { path: source, role: "video", fileName: "v.mp4", source: "imported" });
        const ranges: [number, number][] = [
          [0, 0],
          [0, bytes.length - 1],
          [CHUNK_SIZE - 3, CHUNK_SIZE + 2],
          [CHUNK_SIZE, 2 * CHUNK_SIZE - 1],
          [2 * CHUNK_SIZE + 5, 3 * CHUNK_SIZE + 16],
          [bytes.length - 1, bytes.length - 1],
        ];
        for (const [start, end] of ranges) {
          const pieces: Uint8Array[] = [];
          yield* readRange(db, row.id, start, end, (piece) => Effect.sync(() => void pieces.push(piece)));
          expect(Buffer.concat(pieces).equals(bytes.subarray(start, end + 1))).toBe(true);
          expect(pieces).toHaveLength(Math.floor(end / CHUNK_SIZE) - Math.floor(start / CHUNK_SIZE) + 1);
        }
      }),
    );
  });

  it("fails with a clear message when the file to copy is gone", async () => {
    const error = await withProject((db, dir) =>
      Effect.flip(
        writeMedia(db, { path: path.join(dir, "gone.mp3"), role: "audio", fileName: "gone.mp3", source: "imported" }),
      ),
    );
    expect(error).toBeInstanceOf(FileNotFound);
    expect(error.message).toBe("“gone.mp3” doesn't exist anymore.");
  });

  it("names MIME types by extension and role", () => {
    expect(mimeFor("a.MP3", "audio")).toBe("audio/mpeg");
    expect(mimeFor("a.webm", "audio")).toBe("audio/webm");
    expect(mimeFor("a.webm", "video")).toBe("video/webm");
    expect(mimeFor("a.m4a", "vocals")).toBe("audio/mp4");
    expect(mimeFor("c.jpg", "cover")).toBe("image/jpeg");
    expect(mimeFor("c.unknown", "cover")).toBe("application/octet-stream");
    expect(mimeFor("a.wv", "audio")).toBe("audio/wv");
    // Without an extension, or with one a header can't hold, it is just bytes.
    expect(mimeFor("song", "audio")).toBe("application/octet-stream");
    expect(mimeFor(".hidden", "audio")).toBe("application/octet-stream");
    expect(mimeFor("lied.мп3", "audio")).toBe("application/octet-stream");
    expect(mimeFor("a.b c", "video")).toBe("application/octet-stream");
  });

  it("replaces a role's file and its partner in one go, or neither", async () => {
    await withProject((db, dir) =>
      Effect.gen(function* () {
        const vocals = path.join(dir, "vocals.m4a");
        fs.writeFileSync(vocals, syntheticBytes(10, 1));
        const old = yield* putRole(db, "vocals", { path: vocals, fileName: "Old [VOC].m4a", source: "imported" });
        const error = yield* Effect.flip(
          inTransaction(
            db,
            Effect.andThen(
              putRole(db, "vocals", { path: vocals, fileName: "New [VOC].m4a", source: "generated" }),
              putRole(db, "instrumental", { path: path.join(dir, "gone.m4a"), fileName: "x.m4a", source: "generated" }),
            ),
          ),
        );
        expect(error).toBeInstanceOf(FileNotFound);
        expect((yield* listMedia(db)).map((row) => row.id)).toEqual([old!.id]);
        expect(yield* storedSize(db, old!.id)).toBe(10);
      }),
    );
  });

  it("stores nothing worked out from a file that was replaced meanwhile", async () => {
    await withProject((db, dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, "vocals.m4a");
        fs.writeFileSync(file, syntheticBytes(10, 1));
        const old = yield* putRole(db, "vocals", { path: file, fileName: "Old.m4a", source: "imported" });
        fs.writeFileSync(file, syntheticBytes(10, 2));
        const now = yield* putRole(db, "vocals", { path: file, fileName: "New.m4a", source: "generated" });
        const which = { kind: "waveform", producer: "rms", version: "1" } as const;
        yield* writeF32Analysis(db, which, old!, new Float32Array([0.5]), {});
        expect(yield* readF32Analysis(db, which, old!)).toBeNull();
        yield* writeF32Analysis(db, which, now!, new Float32Array([0.5]), {});
        expect([...(yield* readF32Analysis(db, which, now!))!]).toEqual([0.5]);
      }),
    );
  });
});
