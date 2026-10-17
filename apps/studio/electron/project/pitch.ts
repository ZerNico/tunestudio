/**
 * The sung pitch the editor draws behind the notes: FCPE over the project's vocals, as fractional MIDI every 10 ms
 * (NaN where nothing is sung). Stored on the vocals (`analysis-store.ts`), so it is computed once per vocals file.
 */
import { Effect } from "effect";

import type { Progress, SungPitch } from "../../src/lib/native/types";
import { CHART_STEPS } from "../../src/lib/steps";
import { type FullPitchTrack, HOP_SECONDS, PITCH_SAMPLE_RATE, pitchTrack } from "../charting/pitch-track";
import { ChartFailed } from "../errors";
import { Models } from "../models/models";
import { Native } from "../native/native";
import { Tools } from "../tools/tools";
import { decodeMedia, type F32Analysis, readF32Analysis, writeF32Analysis } from "./analysis-store";
import type { Queryable } from "./database";
import { listMedia, type MediaRow } from "./media";
import type { ProjectSession } from "./projects";

/** Its version changes when what is stored changes, so older tracks are worked out again. */
const PITCH: F32Analysis = { kind: "pitch", producer: "fcpe", version: "1" };
/** Quieter frames than this (dB) are left out: breaths and what the separation left of the band. */
const QUIET_DB = -45;

export const FOLLOWING_THE_MELODY = CHART_STEPS.melody;

/** What is drawn of a pitch track: its MIDI per frame, NaN where nothing (loud enough) is sung. */
export function sungMidi(track: FullPitchTrack): Float32Array {
  return Float32Array.from(track.midi, (value, i) => (track.rms[i]! >= QUIET_DB ? value : Number.NaN));
}

/** Stores the sung pitch of `vocals`, replacing what was stored for them. */
export function writePitch(db: Queryable, vocals: MediaRow, midi: Float32Array) {
  return writeF32Analysis(db, PITCH, vocals, midi, { hop: HOP_SECONDS, quietDb: QUIET_DB });
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
  onProgress: (progress: Progress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const db = session.db;
    const vocals = (yield* listMedia(db)).find((row) => row.role === "vocals");
    if (!vocals) return null;
    const stored = yield* readF32Analysis(db, PITCH, vocals);
    if (stored) return toSungPitch(stored);

    const { ffmpeg } = (yield* Tools.use((tools) => tools.ensure(["ffmpeg"]))).ffmpeg;
    if (!ffmpeg) return yield* new ChartFailed({ message: "FFmpeg couldn't be installed. Try again." });
    const model = yield* (yield* Models).ensure("chartPitch", (received, total) =>
      onProgress({ step: "Getting the pitch model", done: received, total }),
    );
    yield* onProgress({ step: FOLLOWING_THE_MELODY, done: 0, total: 0 });
    const addon = yield* (yield* Native).addon;
    const samples = yield* decodeMedia(db, vocals, ffmpeg, PITCH_SAMPLE_RATE);
    const f0 = yield* Effect.tryPromise({
      try: () => addon.trackPitch(model, samples),
      catch: (error) =>
        new ChartFailed({ message: `Couldn't follow the melody: ${error instanceof Error ? error.message : error}` }),
    });
    const midi = sungMidi(pitchTrack(f0, samples));
    yield* writePitch(db, vocals, midi);
    return toSungPitch(midi);
  });
}
