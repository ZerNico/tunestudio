/**
 * Running the download tools (yt-dlp, FFmpeg, FFprobe), and decoding audio with FFmpeg. Every FFmpeg and FFprobe run on
 * a file passes it through `localInput`: files come from users, downloads and shared projects, and a playlist or
 * concat file inside one mustn't make FFmpeg fetch or read anything but that local file.
 */
import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { LONGEST_SONG_SECONDS } from "../../src/lib/native/contract";
import { type FileError, mapFileError } from "../errors";

/** How a tool run ended: its exit code and everything it wrote to stderr. */
export interface RunResult {
  readonly code: number;
  readonly stderr: string;
}

/** Executables running now (and what they use besides), by path: a tool in use isn't deleted under them. */
const running = new Map<string, number>();

/** Whether a tool run is using a file in `folder`. */
export function runningIn(folder: string, separator: string): boolean {
  const prefix = folder.endsWith(separator) ? folder : folder + separator;
  return [...running.keys()].some((file) => file.startsWith(prefix));
}

const hold = (files: readonly string[], change: 1 | -1) =>
  Effect.sync(() => {
    for (const file of files) {
      const count = (running.get(file) ?? 0) + change;
      if (count > 0) running.set(file, count);
      else running.delete(file);
    }
  });

/**
 * Runs `command` with `args` (no shell), calling `onLine` for each line it prints on stdout. `uses` are other tools
 * it runs (yt-dlp runs FFmpeg). Interrupting the effect kills the process. Fails only if the program can't be started.
 */
export function runTool(
  command: string,
  args: readonly string[],
  onLine: (line: string) => Effect.Effect<void> = () => Effect.void,
  options: { readonly uses?: readonly string[] } = {},
): Effect.Effect<RunResult, string, ChildProcessSpawner.ChildProcessSpawner> {
  const files = [command, ...(options.uses ?? [])];
  return Effect.acquireUseRelease(
    hold(files, 1),
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { windowsHide: true }));
          const [, stderr] = yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runForEach(onLine)),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            ],
            { concurrency: "unbounded" },
          );
          const code = yield* handle.exitCode;
          return { code: Number(code), stderr };
        }),
      ),
    () => hold(files, -1),
  ).pipe(Effect.mapError((error) => error.message));
}

/** The last thing a tool said, for an error message. */
export function lastLine(stderr: string): string {
  return (
    stderr
      .trim()
      .split(/\r?\n/)
      .findLast((line) => line.trim())
      ?.trim() ?? "it stopped without saying why."
  );
}

/** FFmpeg's (or FFprobe's) input options for `file`: only the local file itself may be read. */
export function localInput(file: string): string[] {
  return ["-protocol_whitelist", "file", "-i", file];
}

/** FFprobe's options before the file it reads (it takes the file without `-i`). */
export const PROBE_LOCAL_ONLY = ["-protocol_whitelist", "file"];

/** How much of a file is decoded: a little over the longest song, so a longer file is still noticed as one. */
export const DECODE_SECONDS = LONGEST_SONG_SECONDS + 1;

/**
 * `file`'s first audio stream as float32 samples (interleaved when `channels` is 2) at `sampleRate`, through a
 * scratch file in `folder` (removed again). FFmpeg's default resampler, so charting decodes as the auto-tuner PoC
 * does. Only the first `DECODE_SECONDS` are decoded. `failed` says why FFmpeg couldn't.
 */
export function decodeF32<E>(
  ffmpeg: string,
  file: string,
  options: { readonly sampleRate: number; readonly channels: 1 | 2; readonly folder: string; readonly what: string },
  failed: (message: string) => E,
): Effect.Effect<
  Float32Array,
  E | FileError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    // Its own name: a cancelled decode may still be finishing when the next one starts.
    const raw = paths.join(options.folder, `decoded-${randomUUID().slice(0, 8)}.f32`);
    return yield* Effect.gen(function* () {
      const result = yield* runTool(ffmpeg, [
        "-hide_banner",
        "-nostats",
        "-y",
        "-v",
        "error",
        ...localInput(file),
        "-t",
        String(DECODE_SECONDS),
        "-map",
        "0:a:0",
        "-vn",
        "-f",
        "f32le",
        "-ac",
        String(options.channels),
        "-ar",
        String(options.sampleRate),
        raw,
      ]).pipe(Effect.mapError(failed));
      if (result.code !== 0) return yield* Effect.fail(failed(lastLine(result.stderr)));
      const read = yield* fs.readFile(raw).pipe(mapFileError(options.what, "read"));
      // Float32Array needs its start aligned to 4 bytes.
      const bytes = read.byteOffset % 4 === 0 ? read : read.slice();
      return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    }).pipe(Effect.ensuring(fs.remove(raw, { force: true }).pipe(Effect.ignore)));
  });
}
