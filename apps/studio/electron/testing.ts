/**
 * Helpers for the `electron` Vitest project: temp folders, synthetic songs and a runtime with
 * the real services (projects, recents, file system) and a desktop that records instead of
 * showing dialogs. Not bundled into the app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { Effect, Layer, ManagedRuntime } from "effect";

import { MODELS, Models } from "./models/models";
import { Native, type NativeAddon } from "./native/native";
import { AppLog } from "./services/app-log";
import { Desktop } from "./services/desktop";
import { studioServices } from "./services/layer";
import { downloadsLayer } from "./tools/downloads";

/**
 * A stand-in for the native addon: "separates" the vocals by halving the mix, on the GPU, and
 * reports progress halfway and at the end. The chart models give a steady A4 every frame, a beat
 * every half second, one confident letter per frame and one GAME note per line.
 */
const fakeAddon: NativeAddon = {
  __napiBindingTarget: "native",
  trackPitch: async (_model, samples) => new Float32Array(Math.floor(samples.length / 160) + 1).fill(440),
  beatLogits: async (_logmel, _model, samples) => {
    const frames = Math.floor(samples.length / 441) + 1;
    const beat = Float32Array.from({ length: frames }, (_, i) => (i % 25 === 0 ? 5 : -5));
    return { beat, downbeat: beat.map((logit, i) => (i % 100 === 0 ? logit : -5)) };
  },
  alignerOutputs: async (_aligner, _boundary, samples, onProgress) => {
    onProgress?.(100);
    const frames = Math.floor(samples.length / 320);
    return { emissions: new Float32Array(frames * 31).fill(-3), frames, syllableStarts: new Float32Array(frames) };
  },
  forcedAlignPath: async (_emissions, _classes, from, to, targets) => {
    // Each target on its own frame from the start (a blank between repeated ones, as CTC needs), then blanks.
    const labels: number[] = [];
    for (const target of targets) {
      if (labels.at(-1) === target) labels.push(0);
      labels.push(target);
    }
    const path = Int32Array.from({ length: to - from }, (_, t) => labels[t] ?? 0);
    return { path, scores: new Float32Array(to - from).fill(-0.1) };
  },
  transcribeNotes: async (_folder, _samples, requests, _language, onProgress) => {
    onProgress?.(100);
    const lengths = requests.map((request) => (request.to - request.from) / 44_100);
    return {
      counts: requests.map(() => 1),
      starts: new Float64Array(requests.length),
      ends: Float64Array.from(lengths),
      voiced: new Uint8Array(requests.length).fill(1),
      midi: new Float64Array(requests.length).fill(69),
    };
  },
  predictPitchShifts: async (_model, features) =>
    Float32Array.from({ length: (features.length / 24) * 5 }, (_, i) => (i % 5 === 2 ? 1 : 0)),
  predictNoteEnds: async (_model, features) => new Float32Array(features.length / 27),
  // Balanced harmonics: no reason to move any note by an octave.
  harmonicRatios: async (_samples, notes) => new Float64Array(notes.length * 2),
  separationSampleRate: () => 44_100,
  separateVocals: async (_model, left, right, _options, onProgress) => {
    onProgress?.(50);
    onProgress?.(100);
    return {
      vocalsLeft: left.map((sample) => sample / 2),
      vocalsRight: right.map((sample) => sample / 2),
      device: "gpu",
    };
  },
  transcribeSampleRate: () => 16_000,
  // One line per stretch it is given, plus the caption Whisper likes to make up.
  transcribe: async (_model, _samples, options, onProgress) => {
    onProgress?.(100);
    return {
      language: options.language ?? "en",
      segments: [
        ...(options.ranges ?? []).map((range, index) => ({
          start: range.start,
          end: range.end,
          text: ` Line  ${index + 1} `,
          language: options.language ?? "en",
          confidence: 0.9,
        })),
        { start: 0, end: 1, text: "Thanks for watching!", language: "en", confidence: 0.9 },
      ],
    };
  },
};

export const fakeNative = Layer.succeed(Native, { addon: Effect.succeed(fakeAddon) });

/** Models that are always downloaded already. */
export const fakeModels = Layer.succeed(Models, {
  installed: () => Effect.succeed(true),
  ensure: (model) => Effect.succeed(`/models/${model}`),
  ensureAll: (models) =>
    Effect.succeed(Object.fromEntries(models.map((model) => [model, `/models/${model}`])) as never),
  downloadedAt: () => Effect.succeed(0),
  source: (model) => MODELS[model],
  remove: () => Effect.void,
});

/** A fresh temp folder, removed by `cleanup`. */
export function tempDir(prefix = "tunestudio-test-"): { dir: string; cleanup: () => void } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Deterministic, non-repeating bytes standing in for audio, video or images. */
export function syntheticBytes(size: number, seed = 1): Buffer {
  const bytes = Buffer.alloc(size);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < size; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

export interface SongFiles {
  /** File name → contents (strings are written as UTF-8). */
  [name: string]: string | Uint8Array;
}

/** Writes a song folder `name` into `parent` and returns its path. */
export function writeSong(parent: string, name: string, files: SongFiles): string {
  const folder = path.join(parent, name);
  fs.mkdirSync(folder, { recursive: true });
  for (const [file, contents] of Object.entries(files)) fs.writeFileSync(path.join(folder, file), contents);
  return folder;
}

/** A small solo chart with two lines, a golden note and display breaks. */
export function soloChart(headers = ""): string {
  return [
    "#TITLE:Night Signals",
    "#ARTIST:Test Artist",
    "#LANGUAGE:English, German",
    "#YEAR:2024",
    "#GENRE:Pop",
    "#CREATOR:Tune Studio tests",
    "#MP3:Test Artist - Night Signals.mp3",
    "#COVER:Test Artist - Night Signals [CO].jpg",
    "#BPM:240",
    "#GAP:1250,5",
    "#PREVIEWSTART:12.5",
    "#X-CUSTOM:keep: me",
    "#TAGS:synthetic, test",
    headers,
    ": 0 4 2 Hel",
    ": 4 4 4 lo ",
    "* 8 8 7 world",
    "- 18",
    "F 20 4 0 spo",
    "R 24 4 0 ken ",
    ": 28 6 -3 end",
    "E",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n")
    .concat("\n");
}

export interface Recorded {
  revealed: string[];
  /** Answers for the next dialogs, in order; `null` is a cancel. */
  answers: (string | null)[];
}

/** A desktop whose dialogs return queued answers and whose thumbnails are the image itself. */
export function recordingDesktop(musicFolder: string) {
  const recorded: Recorded = { revealed: [], answers: [] };
  const answer = () => Effect.sync(() => recorded.answers.shift() ?? null);
  const layer = Layer.succeed(Desktop, {
    chooseSong: answer,
    chooseProject: answer,
    chooseProjectLocation: answer,
    chooseExportFolder: answer,
    chooseTextFile: answer,
    chooseImage: answer,
    country: "US",
    reveal: (target) => Effect.sync(() => void recorded.revealed.push(target)),
    thumbnail: (image) => Effect.succeed(`data:image/jpeg;base64,${Buffer.from(image).toString("base64")}`),
    musicFolder,
  });
  return { recorded, layer };
}

/** A runtime like the app's, in `dir`: real projects, recents and files, recorded desktop and log, no internet. */
export function testRuntime(dir: string) {
  const { recorded, layer } = recordingDesktop(path.join(dir, "Music"));
  const lines: string[] = [];
  const log = Layer.succeed(AppLog, {
    write: (level, target, message) => Effect.sync(() => void lines.push(`${level} ${target} ${message}`)),
  });
  const runtime = ManagedRuntime.make(
    studioServices({
      appVersion: "0.0.0-test",
      recentsFile: path.join(dir, "data", "recent-projects.json"),
      settingsFile: path.join(dir, "data", "settings.json"),
      draftsFolder: path.join(dir, "data", "drafts"),
      toolsFolder: path.join(dir, "data", "tools"),
      modelsFolder: path.join(dir, "data", "models"),
      nativeFolder: path.join(dir, "native"),
      native: fakeNative,
      models: fakeModels,
      // Nothing is downloaded: a test that needs the internet fakes it.
      downloads: downloadsLayer({ hosts: [] }),
      log,
      desktop: layer,
    }),
  );
  return { runtime, recorded, lines };
}

/** One entry of a test zip: a file with its bytes and mode, a folder, or a symlink. */
export type ZipEntry = {
  name: string;
  data?: string | Uint8Array;
  mode?: number;
  link?: string;
  /** What the zip claims, instead of the truth: for damaged or hostile zips. */
  size?: number;
  crc?: number;
  encrypted?: boolean;
};

/** A zip file as Info-ZIP on Unix writes it (deflated files, Unix modes, symlinks). */
export function zipOf(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.link ?? entry.data ?? "");
    const folder = entry.name.endsWith("/");
    const compressed = entry.link || folder ? content : deflateRawSync(content);
    const method = entry.link || folder ? 0 : 8;
    const type = entry.link ? 0o120000 : folder ? 0o040000 : 0o100000;
    const mode = type | (entry.mode ?? (folder ? 0o755 : 0o644));
    const crc = entry.crc ?? crc32(content);
    const size = entry.size ?? content.length;
    const flags = entry.encrypted ? 1 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 30, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE((mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    directory.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directoryBytes, end]);
}
