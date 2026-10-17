/**
 * Analyses of a project's media stored as float32 (`analysis` rows of `encoding` "f32"): the sung pitch and the
 * waveform. A row belongs to a file by its checksum, so it is out of date when the file changes; one of an older
 * producer version is worked out again. Also decoding a media file for one, through a temporary copy.
 */
import { and, desc, eq } from "drizzle-orm";
import { Effect, FileSystem, Path } from "effect";

import { decodeMono } from "../charting/audio";
import { mapFileError } from "../errors";
import { orDiskFull, type Queryable } from "./database";
import { type MediaRow, writeMediaToFile } from "./media";
import { type ANALYSIS_KINDS, analysis } from "./schema";

type Kind = (typeof ANALYSIS_KINDS)[number];

/** What makes an analysis: its kind, and the producer and version that work it out. */
export interface F32Analysis {
  kind: Kind;
  producer: string;
  version: string;
}

/** The stored values of `which` for `input`, or null when there are none (or only from another producer version). */
export function readF32Analysis(db: Queryable, which: F32Analysis, input: MediaRow) {
  return Effect.gen(function* () {
    const [row] = yield* db
      .select()
      .from(analysis)
      .where(
        and(
          eq(analysis.kind, which.kind),
          eq(analysis.inputSha256, input.sha256),
          eq(analysis.producer, which.producer),
          eq(analysis.producerVersion, which.version),
        ),
      )
      .orderBy(desc(analysis.id))
      .limit(1)
      .pipe(Effect.orDie);
    if (!row || row.encoding !== "f32") return null;
    const bytes = Buffer.from(row.data);
    return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  });
}

/** Stores `values` as `which` for `input`, replacing what was stored for that file. */
export function writeF32Analysis(
  db: Queryable,
  which: F32Analysis,
  input: MediaRow,
  values: Float32Array,
  params: Record<string, unknown>,
) {
  return Effect.gen(function* () {
    yield* db
      .delete(analysis)
      .where(and(eq(analysis.kind, which.kind), eq(analysis.inputSha256, input.sha256)))
      .pipe(orDiskFull);
    yield* db
      .insert(analysis)
      .values({
        kind: which.kind,
        inputMediaId: input.id,
        inputSha256: input.sha256,
        producer: which.producer,
        producerVersion: which.version,
        params: JSON.stringify(params),
        encoding: "f32",
        data: Buffer.from(values.buffer, values.byteOffset, values.byteLength),
      })
      .pipe(orDiskFull);
  });
}

/** `input` decoded to mono at `sampleRate` with `ffmpeg`, from a copy in a temporary folder (gone afterwards). */
export function decodeMedia(db: Queryable, input: MediaRow, ffmpeg: string, sampleRate: number) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const folder = yield* fs
      .makeTempDirectoryScoped({ prefix: `tunestudio-${input.role}-` })
      .pipe(mapFileError("a temporary folder", "create"));
    const file = paths.join(folder, `${input.role}${paths.extname(input.fileName) || ".audio"}`);
    yield* writeMediaToFile(db, input, file);
    return yield* decodeMono(ffmpeg, file, sampleRate, folder);
  }).pipe(Effect.scoped);
}
