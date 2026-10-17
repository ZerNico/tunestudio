/**
 * Decoding a song for the chart models: mono float samples at the rate each model reads, with our FFmpeg's default
 * resampler (`-ac 1 -ar <rate>`), the way the auto-tuner PoC's `audio.load` decodes. Nothing is re-encoded.
 */
import { ChartFailed } from "../errors";
import { decodeF32 } from "../tools/ffmpeg";

/** `file`'s first audio stream as mono float32 samples at `sampleRate`, through a scratch file in `folder`. */
export function decodeMono(ffmpeg: string, file: string, sampleRate: number, folder: string) {
  return decodeF32(
    ffmpeg,
    file,
    { sampleRate, channels: 1, folder, what: "the song" },
    (message) => new ChartFailed({ message: `Couldn't read the song: ${message}` }),
  );
}
