import { Effect, FileSystem, Path } from "effect";

import { LONGEST_SONG_SECONDS } from "../../src/lib/native/contract";
import type { ImportProgress } from "../../src/lib/native/types";
import type { AudioFormat } from "../../src/lib/settings";
import { mapFileError, SeparationFailed } from "../errors";
import { Models } from "../models/models";
import { Native } from "../native/native";
import { AppLog } from "../services/app-log";
import { ENCODERS, lastLine } from "../youtube/loudness";
import { runTool } from "../youtube/run";

export const SEPARATING = "Separating the voice";
export const GETTING_MODEL = "Getting the voice separation model";

const failed = (message: string) => new SeparationFailed({ message: `Couldn't separate the voice: ${message}` });

/** Raw 32-bit float samples, as ffmpeg reads and writes them with `-f f32le`. */
function rawArgs(sampleRate: number) {
  return ["-f", "f32le", "-ar", String(sampleRate), "-ac", "2"];
}

/**
 * The audio's bitrate in kbit/s, or null if FFprobe can't tell. Opus streams don't state their
 * own, so the file's is the fallback (audio-only files, so it is the same).
 */
export function audioBitrate(ffprobe: string, file: string) {
  return Effect.gen(function* () {
    const lines: string[] = [];
    const result = yield* runTool(
      ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=bit_rate:format=bit_rate",
        "-of",
        "csv=p=0",
        file,
      ],
      (line) => Effect.sync(() => void lines.push(line)),
    );
    if (result.code !== 0) return null;
    const rate = lines.map((line) => Number.parseInt(line, 10)).find((value) => Number.isFinite(value) && value > 0);
    return rate === undefined ? null : Math.round(rate / 1000);
  }).pipe(Effect.orElseSucceed(() => null));
}

/**
 * Separates `audio` into its vocals and the instrumental (the song without them), as
 * `vocals.<format>` and `instrumental.<format>` in `folder`, encoded like the song's audio: its
 * format, at its own bitrate (YouTube's M4A and Opus are kept as served, often below the
 * setting) but no higher than `bitrate`. Downloads the model first if needed. Runs on the GPU
 * when there is one.
 */
export function separateStems(
  input: { ffmpeg: string; ffprobe: string; audio: string; folder: string; format: AudioFormat; bitrate: number },
  onProgress: (progress: ImportProgress) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const log = yield* AppLog;
    const addon = yield* (yield* Native).addon;
    const sampleRate = addon.separationSampleRate();

    const model = yield* (yield* Models).ensure("separation", (received, total) =>
      onProgress({ step: GETTING_MODEL, done: received, total }),
    );
    yield* onProgress({ step: SEPARATING, done: 0, total: 100, unit: "percent" });

    const mixFile = paths.join(input.folder, "mix.f32");
    const raw = paths.join(input.folder, "stem.f32");
    const source = yield* audioBitrate(input.ffprobe, input.audio);
    const bitrate = source === null ? input.bitrate : Math.min(input.bitrate, source);

    /** Writes interleaved stereo samples as `<name>.<format>`. */
    const encode = (samples: Float32Array, name: string) =>
      Effect.gen(function* () {
        const output = paths.join(input.folder, `${name}.${input.format}`);
        yield* fs.writeFile(raw, new Uint8Array(samples.buffer)).pipe(mapFileError(`the ${name}`, "save"));
        const result = yield* runTool(input.ffmpeg, [
          "-hide_banner",
          "-nostats",
          "-y",
          ...rawArgs(sampleRate),
          "-i",
          raw,
          ...(input.format === "opus" ? ["-ar", "48000"] : []),
          "-c:a",
          ENCODERS[input.format],
          "-b:a",
          `${bitrate}k`,
          output,
        ]).pipe(Effect.mapError(failed));
        if (result.code !== 0) return yield* failed(lastLine(result.stderr));
        return output;
      });

    return yield* Effect.gen(function* () {
      const decode = yield* runTool(input.ffmpeg, [
        "-hide_banner",
        "-nostats",
        "-y",
        "-i",
        input.audio,
        "-map",
        "0:a:0",
        "-vn",
        ...rawArgs(sampleRate),
        mixFile,
      ]).pipe(Effect.mapError(failed));
      if (decode.code !== 0) return yield* failed(lastLine(decode.stderr));

      // Separation holds the song in memory several times over: hour-long uploads aren't songs.
      const size = Number((yield* fs.stat(mixFile).pipe(mapFileError("the song", "read"))).size);
      if (size / (4 * 2 * sampleRate) > LONGEST_SONG_SECONDS) {
        return yield* failed(`the song is longer than ${LONGEST_SONG_SECONDS / 60} minutes.`);
      }
      const read = yield* fs.readFile(mixFile).pipe(mapFileError("the song", "read"));
      // Float32Array needs its start aligned to 4 bytes.
      const bytes = read.byteOffset % 4 === 0 ? read : read.slice();
      const mix = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
      const frames = Math.floor(mix.length / 2);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        left[i] = mix[2 * i]!;
        right[i] = mix[2 * i + 1]!;
      }
      yield* fs.remove(mixFile).pipe(Effect.ignore);

      const started = Date.now();
      const stems = yield* Effect.tryPromise({
        try: (signal) =>
          addon.separateVocals(
            model,
            left,
            right,
            {},
            (percent) => Effect.runFork(onProgress({ step: SEPARATING, done: percent, total: 100, unit: "percent" })),
            signal,
          ),
        catch: (error) => failed(error instanceof Error ? error.message : String(error)),
      });
      if (stems.gpuProblem) {
        yield* log.write("WARN", "separation", `The GPU couldn't separate, so the CPU did: ${stems.gpuProblem}`);
      }
      yield* log.write(
        "INFO",
        "separation",
        `Separated ${(frames / sampleRate).toFixed(0)} s of audio on the ${stems.device.toUpperCase()} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
      );

      // The model gives the vocals; the instrumental is what is left of the song without them.
      const vocals = new Float32Array(frames * 2);
      const instrumental = new Float32Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        vocals[2 * i] = stems.vocalsLeft[i]!;
        vocals[2 * i + 1] = stems.vocalsRight[i]!;
        instrumental[2 * i] = left[i]! - stems.vocalsLeft[i]!;
        instrumental[2 * i + 1] = right[i]! - stems.vocalsRight[i]!;
      }
      return {
        vocals: yield* encode(vocals, "vocals"),
        instrumental: yield* encode(instrumental, "instrumental"),
      };
    }).pipe(
      Effect.ensuring(
        Effect.all([fs.remove(mixFile, { force: true }), fs.remove(raw, { force: true })]).pipe(Effect.ignore),
      ),
    );
  });
}
