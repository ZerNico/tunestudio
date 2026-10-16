/**
 * The sung pitch the editor draws behind the notes: FCPE over the project's vocals, as fractional MIDI every 10 ms
 * (NaN where nothing is sung). Stored as `analysis` of kind "pitch" on the vocals, so it is computed once per vocals
 * file and is out of date when the vocals change (their checksum).
 */
import { and, desc, eq } from "drizzle-orm";
import { Effect, FileSystem, Path } from "effect";

import { CHART_STEPS } from "../../src/lib/chart-steps";
import type { ImportProgress, SungPitch } from "../../src/lib/native/types";
import { decodeMono } from "../charting/audio";
import { type FullPitchTrack, HOP_SECONDS, PITCH_SAMPLE_RATE, pitchTrack } from "../charting/pitch-track";
import { ChartFailed, mapFileError } from "../errors";
import { Models } from "../models/models";
import { Native } from "../native/native";
import { Tools } from "../tools/tools";
import { orDiskFull, type Queryable } from "./database";
import { listMedia, type MediaRow, writeMediaToFile } from "./media";
import type { ProjectSession } from "./projects";
import { analysis } from "./schema";

const PRODUCER = "fcpe";
/** Changes when what is stored changes, so older tracks are computed again. */
const PRODUCER_VERSION = "1";
/** Quieter frames than this (dB) are left out: breaths and what the separation left of the band. */
const QUIET_DB = -45;

export const FOLLOWING_THE_MELODY = CHART_STEPS.melody;

/** What is drawn of a pitch track: its MIDI per frame, NaN where nothing (loud enough) is sung. */
export function sungMidi(track: FullPitchTrack): Float32Array {
  return Float32Array.from(track.midi, (value, i) => (track.rms[i]! >= QUIET_DB ? value : Number.NaN));
}

/** Stores the sung pitch of `vocals`, replacing what was stored for them. */
export function writePitch(db: Queryable, vocals: MediaRow, midi: Float32Array) {
  return Effect.gen(function* () {
    yield* db
      .delete(analysis)
      .where(and(eq(analysis.kind, "pitch"), eq(analysis.inputSha256, vocals.sha256)))
      .pipe(orDiskFull);
    yield* db
      .insert(analysis)
      .values({
        kind: "pitch",
        inputMediaId: vocals.id,
        inputSha256: vocals.sha256,
        producer: PRODUCER,
        producerVersion: PRODUCER_VERSION,
        params: JSON.stringify({ hop: HOP_SECONDS, quietDb: QUIET_DB }),
        encoding: "f32",
        data: Buffer.from(midi.buffer, midi.byteOffset, midi.byteLength),
      })
      .pipe(orDiskFull);
  });
}

/** The stored track for these vocals, or null. */
function readStored(db: Queryable, vocals: MediaRow) {
  return Effect.gen(function* () {
    const [row] = yield* db
      .select()
      .from(analysis)
      .where(
        and(
          eq(analysis.kind, "pitch"),
          eq(analysis.inputSha256, vocals.sha256),
          eq(analysis.producer, PRODUCER),
          eq(analysis.producerVersion, PRODUCER_VERSION),
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

/** The frames as sent to the renderer: MIDI with one decimal, null where nothing is sung. */
function toSungPitch(midi: Float32Array): SungPitch {
  return {
    hop: HOP_SECONDS,
    midi: Array.from(midi, (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null)),
  };
}

/**
 * The sung pitch of the project's vocals: stored, or computed now (downloading the pitch model first if needed) and
 * stored. Null when the project has no vocals.
 */
export function sungPitch(
  session: ProjectSession,
  onProgress: (progress: ImportProgress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const db = session.db;
    const vocals = (yield* listMedia(db)).find((row) => row.role === "vocals");
    if (!vocals) return null;
    const stored = yield* readStored(db, vocals);
    if (stored) return toSungPitch(stored);

    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const { ffmpeg } = (yield* Tools.use((tools) => tools.ensure(["ffmpeg"]))).ffmpeg;
    if (!ffmpeg) return yield* new ChartFailed({ message: "FFmpeg couldn't be installed. Try again." });
    const model = yield* (yield* Models).ensure("chartPitch", (received, total) =>
      onProgress({ step: "Getting the pitch model", done: received, total }),
    );
    yield* onProgress({ step: FOLLOWING_THE_MELODY, done: 0, total: 0 });
    const addon = yield* (yield* Native).addon;
    const folder = yield* fs
      .makeTempDirectoryScoped({ prefix: "tunestudio-pitch-" })
      .pipe(mapFileError("a temporary folder", "create"));
    const file = paths.join(folder, `vocals${paths.extname(vocals.fileName) || ".audio"}`);
    yield* writeMediaToFile(db, vocals, file);
    const samples = yield* decodeMono(ffmpeg, file, PITCH_SAMPLE_RATE, folder);
    const f0 = yield* Effect.tryPromise({
      try: () => addon.trackPitch(model, samples),
      catch: (error) =>
        new ChartFailed({ message: `Couldn't follow the melody: ${error instanceof Error ? error.message : error}` }),
    });
    const midi = sungMidi(pitchTrack(f0, samples));
    yield* writePitch(db, vocals, midi);
    return toSungPitch(midi);
  }).pipe(Effect.scoped);
}
