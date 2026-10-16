import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import type { ImportProgress } from "../../src/lib/native/types";
import { AppLog } from "../services/app-log";
import { Drafts, draftsLayer } from "../services/drafts";
import { settingsLayer } from "../services/settings";
import { fakeModels, fakeNative, recordingDesktop, tempDir } from "../testing";
import { Tools } from "../tools/tools";
import { audioFileIntoDraft, inspectAudioFile } from "./audio-file";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

/**
 * A stand-in for FFprobe and FFmpeg: FFprobe describes the file as `probe.json` says, FFmpeg writes the artwork's
 * bytes for an image and otherwise passes its input's bytes on. Every call is recorded in `calls.jsonl`.
 */
const FAKE_TOOL = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const tool = process.argv[2];
const args = process.argv.slice(3);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ tool, args }) + "\n");
const value = (flag) => args[args.indexOf(flag) + 1];
if (tool === "ffprobe") {
  if (args.includes("json")) process.stdout.write(fs.readFileSync(path.join(dir, "probe.json"), "utf8"));
  else console.log("192000");
  process.exit(0);
}
const output = args.at(-1);
fs.writeFileSync(output, args.includes("image2") ? "artwork" : fs.readFileSync(value("-i")));
process.exit(0);
`;

const AUDIO = { codec_type: "audio", codec_name: "mp3" };
const ARTWORK = { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } };

function setup(probe: unknown) {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "fake.cjs"), FAKE_TOOL);
  fs.writeFileSync(path.join(bin, "probe.json"), JSON.stringify(probe));
  const executable = (name: string) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "fake.cjs")}" ${name} "$@"\n`, {
      mode: 0o755,
    });
    return file;
  };
  const tools = Layer.succeed(Tools, {
    folder: path.join(dir, "tools"),
    status: Effect.succeed([]),
    ensure: () =>
      Effect.succeed({
        "yt-dlp": {},
        quickjs: {},
        ffmpeg: { ffmpeg: executable("ffmpeg"), ffprobe: executable("ffprobe") },
      }),
    remove: () => Effect.void,
  });
  const log = Layer.succeed(AppLog, { write: () => Effect.void });
  const layer = Layer.mergeAll(
    tools,
    log,
    recordingDesktop(path.join(dir, "Music")).layer,
    settingsLayer(path.join(dir, "settings.json")),
    draftsLayer(path.join(dir, "drafts")),
    fakeNative,
    fakeModels,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  // A song file whose bytes stand in for samples (two floats).
  const song = path.join(dir, "Carla Ahad - Blauer Himmel.MP3");
  fs.writeFileSync(song, Buffer.from(new Float32Array([0.5, -0.25]).buffer));
  const calls = () =>
    fs
      .readFileSync(path.join(bin, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { tool: string; args: string[] });
  return { layer, song, calls };
}

describe("inspectAudioFile", () => {
  it.effect("reads artist, title, year, length and artwork from the tags", () => {
    const { layer, song } = setup({
      format: { duration: "213.4", tags: { ARTIST: "RAUM27", title: "Sommerregen", date: "2019-05-03" } },
      streams: [AUDIO, ARTWORK],
    });
    return Effect.gen(function* () {
      expect(yield* inspectAudioFile(song)).toEqual({
        name: "Carla Ahad - Blauer Himmel.MP3",
        size: 8,
        format: "MP3",
        duration: 213.4,
        artist: "RAUM27",
        title: "Sommerregen",
        year: 2019,
        artwork: `data:image/jpeg;base64,${Buffer.from("artwork").toString("base64")}`,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("takes artist and title from an untagged file's name, and has no artwork without one", () => {
    const { layer, song } = setup({ format: { duration: "180" }, streams: [AUDIO] });
    return Effect.gen(function* () {
      expect(yield* inspectAudioFile(song)).toMatchObject({
        artist: "Carla Ahad",
        title: "Blauer Himmel",
        year: null,
        artwork: null,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a file without sound, and one too long for a song", () => {
    const silent = setup({ format: { duration: "180" }, streams: [ARTWORK] });
    const long = setup({ format: { duration: "3600" }, streams: [AUDIO] });
    return Effect.gen(function* () {
      const noSound = yield* Effect.flip(inspectAudioFile(silent.song).pipe(Effect.provide(silent.layer)));
      expect(noSound).toMatchObject({ _tag: "AudioUnreadable", message: expect.stringContaining("can't read") });
      const tooLong = yield* Effect.flip(inspectAudioFile(long.song).pipe(Effect.provide(long.layer)));
      expect(tooLong).toMatchObject({ _tag: "AudioUnreadable", message: expect.stringContaining("longer than 20") });
    });
  });
});

describe("audioFileIntoDraft", () => {
  it.effect("copies the file as it is, takes its artwork and separates the voice", () => {
    const { layer, song, calls } = setup({ format: { duration: "180" }, streams: [AUDIO, ARTWORK] });
    const progress: ImportProgress[] = [];
    return Effect.gen(function* () {
      const imported = yield* audioFileIntoDraft(song, (step) => Effect.sync(() => void progress.push(step)));
      const draft = yield* Drafts.use((drafts) => drafts.get(imported.draftId));
      expect(draft.source).toEqual({ kind: "file", path: song });
      expect(draft.media!.audio).toBe(path.join(draft.folder, "audio.mp3"));
      expect(fs.readFileSync(draft.media!.audio).equals(fs.readFileSync(song))).toBe(true);
      expect(fs.readFileSync(draft.media!.cover!, "utf8")).toBe("artwork");
      expect(draft.media!.vocals).toBe(path.join(draft.folder, "vocals.m4a"));
      expect(imported).toEqual({ draftId: draft.id, audio: { size: 8 }, video: null, videoProblem: null });
      // Nothing writes over the song: FFmpeg only reads it.
      const ffmpeg = calls().filter((call) => call.tool === "ffmpeg");
      expect(ffmpeg.filter((call) => call.args.at(-1) === draft.media!.audio)).toEqual([]);
      expect(progress[0]).toEqual({ step: "Copying the song", done: 0, total: 0 });
      expect(progress).toContainEqual({ step: "Separating the voice", done: 50, total: 100, unit: "percent" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves no draft when the file can't be used", () => {
    const { layer, song } = setup({ format: { duration: "3600" }, streams: [AUDIO] });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(audioFileIntoDraft(song));
      expect(error._tag).toBe("AudioUnreadable");
    }).pipe(Effect.provide(layer));
  });
});
