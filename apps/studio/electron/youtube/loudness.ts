import { Effect, FileSystem } from "effect";

import type { AudioFormat } from "../../src/lib/settings";
import { VideoDownloadFailed } from "../errors";
import { lastLine, localInput, runTool } from "../tools/ffmpeg";

/*
 * Volume normalization as USDB Syncer does it (with ffmpeg-normalize): EBU R128 loudness in two
 * passes, to -18 LUFS (ReplayGain's reference), or -23 LUFS for Opus, whose players expect R128.
 * "replaygain" only writes the gain into the file's tags; "rewrite" encodes the audio again at
 * the target loudness.
 */

/** What ffmpeg's loudnorm filter measured in its first pass. */
export interface Loudness {
  readonly integrated: number;
  readonly truePeak: number;
  readonly range: number;
  readonly threshold: number;
  readonly offset: number;
}

const TRUE_PEAK = -2;

/** The loudness to aim for, in LUFS. */
export function targetLoudness(format: AudioFormat): number {
  return format === "opus" ? -23 : -18;
}

/** ffmpeg's encoder for each format. */
export const ENCODERS: Record<AudioFormat, string> = {
  m4a: "aac",
  mp3: "libmp3lame",
  ogg: "libvorbis",
  opus: "libopus",
};

const failed = (message: string) => new VideoDownloadFailed({ message: `Couldn't adjust the volume: ${message}` });

/** Reads the JSON block loudnorm prints at the end of its output. */
export function parseLoudness(stderr: string): Loudness | undefined {
  const block = stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1);
  try {
    const json = JSON.parse(block) as Record<string, string>;
    const value = (key: string) => Number.parseFloat(json[key] ?? "");
    const measured = {
      integrated: value("input_i"),
      truePeak: value("input_tp"),
      range: value("input_lra"),
      threshold: value("input_thresh"),
      offset: value("target_offset"),
    };
    return Object.values(measured).every(Number.isFinite) ? measured : undefined;
  } catch {
    return undefined;
  }
}

/** The first pass: measures `input` (its first audio stream). Silence can't be normalized. */
export function measureLoudness(ffmpeg: string, input: string, target: number) {
  return Effect.gen(function* () {
    const result = yield* runTool(ffmpeg, [
      "-hide_banner",
      "-nostats",
      ...localInput(input),
      "-map",
      "0:a:0",
      "-af",
      `loudnorm=I=${target}:TP=${TRUE_PEAK}:LRA=7:print_format=json`,
      "-f",
      "null",
      "-",
    ]).pipe(Effect.mapError(failed));
    const loudness = result.code === 0 ? parseLoudness(result.stderr) : undefined;
    if (!loudness || !Number.isFinite(loudness.integrated) || loudness.integrated < -70) {
      return yield* failed("the audio is silent or couldn't be read.");
    }
    return loudness;
  });
}

/** Encodes `input` to `output` (in `format`) at the target loudness. */
export function rewriteLoudness(
  ffmpeg: string,
  input: string,
  output: string,
  options: { format: AudioFormat; bitrate: number },
) {
  return Effect.gen(function* () {
    const target = targetLoudness(options.format);
    const measured = yield* measureLoudness(ffmpeg, input, target);
    // Keeping the song's own loudness range lets loudnorm apply one linear gain instead of
    // compressing it.
    const range = Math.min(50, Math.max(1, Math.ceil(measured.range * 10) / 10));
    const filter = [
      `loudnorm=I=${target}`,
      `TP=${TRUE_PEAK}`,
      `LRA=${range}`,
      `measured_I=${measured.integrated}`,
      `measured_TP=${measured.truePeak}`,
      `measured_LRA=${measured.range}`,
      `measured_thresh=${measured.threshold}`,
      `offset=${measured.offset}`,
      "linear=true",
      "print_format=summary",
    ].join(":");
    const result = yield* runTool(ffmpeg, [
      "-hide_banner",
      "-nostats",
      "-y",
      ...localInput(input),
      "-map",
      "0:a:0",
      "-vn",
      "-af",
      filter,
      // loudnorm works at 192 kHz; this brings it back to the usual rate.
      "-ar",
      options.format === "opus" ? "48000" : "44100",
      "-c:a",
      ENCODERS[options.format],
      "-b:a",
      `${options.bitrate}k`,
      output,
    ]).pipe(Effect.mapError(failed));
    if (result.code !== 0) return yield* failed(lastLine(result.stderr));
  });
}

/** The tags that tell players how much to turn the song up or down. */
export function gainTags(format: AudioFormat, measured: Loudness): Record<string, string> {
  if (format === "opus") {
    // RFC 7845: a Q7.8 number of dB relative to -23 LUFS.
    return { R128_TRACK_GAIN: String(Math.round((-23 - measured.integrated) * 256)) };
  }
  return {
    REPLAYGAIN_TRACK_GAIN: `${(-18 - measured.integrated).toFixed(2)} dB`,
    REPLAYGAIN_TRACK_PEAK: (10 ** (measured.truePeak / 20)).toFixed(6),
  };
}

/** Writes ReplayGain (or R128) tags into `file` without encoding the audio again. */
export function writeGainTags(ffmpeg: string, file: string, format: AudioFormat) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const measured = yield* measureLoudness(ffmpeg, file, targetLoudness(format));
    const tagged = file.replace(/(\.[^.]+)$/, ".tagged$1");
    const tags = Object.entries(gainTags(format, measured)).flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
    const result = yield* runTool(ffmpeg, [
      "-hide_banner",
      "-nostats",
      "-y",
      ...localInput(file),
      "-map",
      "0",
      "-c",
      "copy",
      ...tags,
      // MP4 only keeps tags it knows about without this.
      ...(format === "m4a" ? ["-movflags", "use_metadata_tags"] : []),
      tagged,
    ]).pipe(Effect.mapError(failed));
    if (result.code !== 0) return yield* failed(lastLine(result.stderr));
    yield* fs.rename(tagged, file).pipe(Effect.mapError(() => failed("the tagged file couldn't be saved.")));
  });
}
