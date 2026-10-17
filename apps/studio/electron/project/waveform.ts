/**
 * The waveform the editor can show under the roll: how loud the vocals are (or the song, without vocals), as the
 * average loudness (RMS) of every 10 ms, which shows where syllables start more clearly than the loudest sample.
 * Stored on that file (`analysis-store.ts`), so it is worked out once per file. Only a view: without FFmpeg (offline)
 * or with a file it can't read, there is no waveform.
 */
import { Effect } from "effect";

import type { Waveform } from "../../src/lib/native/types";
import { Tools } from "../tools/tools";
import { decodeMedia, type F32Analysis, readF32Analysis, writeF32Analysis } from "./analysis-store";
import { listMedia } from "./media";
import type { ProjectSession } from "./projects";

const WAVEFORM: F32Analysis = { kind: "waveform", producer: "rms", version: "1" };
/** Seconds per value. */
const HOP = 0.01;
/** Enough to see where syllables start, and quick to decode. */
const SAMPLE_RATE = 8000;

/** The average loudness (RMS, 0-1) of every `hop` seconds of `samples`. */
export function levelsOf(samples: Float32Array, sampleRate: number, hop = HOP): Float32Array {
  const size = Math.max(1, Math.round(sampleRate * hop));
  const levels = new Float32Array(Math.ceil(samples.length / size));
  for (let frame = 0; frame < levels.length; frame++) {
    let sum = 0;
    const end = Math.min(samples.length, (frame + 1) * size);
    for (let i = frame * size; i < end; i++) sum += samples[i]! ** 2;
    levels[frame] = Math.min(1, Math.sqrt(sum / (end - frame * size)));
  }
  return levels;
}

/** The values as sent to the renderer: three decimals are plenty to draw. */
function toWaveform(levels: Float32Array): Waveform {
  return { hop: HOP, levels: Array.from(levels, (value) => Math.round(value * 1000) / 1000) };
}

/** The waveform of the project's vocals (or its song without them): stored, or worked out now and stored. */
export function waveform(session: ProjectSession) {
  return Effect.gen(function* () {
    const db = session.db;
    const media = yield* listMedia(db);
    const input = media.find((row) => row.role === "vocals") ?? media.find((row) => row.role === "audio");
    if (!input) return null;
    const stored = yield* readF32Analysis(db, WAVEFORM, input);
    if (stored) return toWaveform(stored);

    const samples = yield* Effect.gen(function* () {
      const { ffmpeg } = (yield* Tools.use((tools) => tools.ensure(["ffmpeg"]))).ffmpeg;
      return ffmpeg ? yield* decodeMedia(db, input, ffmpeg, SAMPLE_RATE) : null;
    }).pipe(Effect.catch((error) => Effect.as(Effect.logWarning("No waveform", error), null)));
    if (!samples) return null;
    const levels = levelsOf(samples, SAMPLE_RATE);
    yield* writeF32Analysis(db, WAVEFORM, input, levels, { hop: HOP, sampleRate: SAMPLE_RATE });
    return toWaveform(levels);
  });
}
