/**
 * Decoding a song for the chart models: mono float samples at the rate each model reads, with our FFmpeg's default
 * resampler (`-ac 1 -ar <rate>`), the way the auto-tuner PoC's `audio.load` decodes. Nothing is re-encoded.
 */
import { Effect, FileSystem, Path } from "effect";

import { ChartFailed, mapFileError } from "../errors";
import { lastLine } from "../youtube/loudness";
import { runTool } from "../youtube/run";

/** `file`'s first audio stream as mono float32 samples at `sampleRate`, through a scratch file in `folder`. */
export function decodeMono(ffmpeg: string, file: string, sampleRate: number, folder: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const raw = paths.join(folder, `decoded-${sampleRate}.f32`);
    return yield* Effect.gen(function* () {
      const result = yield* runTool(ffmpeg, [
        "-hide_banner",
        "-nostats",
        "-y",
        "-v",
        "error",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-vn",
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        String(sampleRate),
        raw,
      ]).pipe(Effect.mapError((message) => new ChartFailed({ message: `Couldn't read the song: ${message}` })));
      if (result.code !== 0)
        return yield* new ChartFailed({ message: `Couldn't read the song: ${lastLine(result.stderr)}` });
      const read = yield* fs.readFile(raw).pipe(mapFileError("the song", "read"));
      // Float32Array needs its start aligned to 4 bytes.
      const bytes = read.byteOffset % 4 === 0 ? read : read.slice();
      return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    }).pipe(Effect.ensuring(fs.remove(raw, { force: true }).pipe(Effect.ignore)));
  });
}
