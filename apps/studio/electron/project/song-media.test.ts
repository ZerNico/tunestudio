import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AppLog } from "../services/app-log";
import { settingsLayer } from "../services/settings";
import { fakeModels, fakeNative, recordingDesktop, soloChart, syntheticBytes, tempDir, writeSong } from "../testing";
import { Tools } from "../tools/tools";
import { importSong, inspectSong } from "../ultrastar/song-import";
import { listMedia, writeMediaToFile } from "./media";
import { projectsLayer } from "./projects";
import { removeVideo, replaceSongMedia, separateSong } from "./song-media";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

/**
 * FFprobe says a file has sound by its extension (and a picture for videos); FFmpeg passes its input's bytes on (the
 * separation decodes and encodes with it).
 */
const FAKE_TOOL = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(3);
if (process.argv[2] === "ffprobe") {
  const file = args.at(-1);
  if (!args.includes("json")) { console.log("128000"); process.exit(0); }
  const streams = /\.(mp3|m4a)$/i.test(file)
    ? [{ codec_type: "audio" }]
    : /\.mp4$/.test(file) ? [{ codec_type: "video" }, { codec_type: "audio" }] : [];
  process.stdout.write(JSON.stringify({ format: { duration: "200" }, streams }));
  process.exit(0);
}
fs.writeFileSync(args.at(-1), fs.readFileSync(args[args.indexOf("-i") + 1]));
`;

function setup() {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  fs.writeFileSync(path.join(dir, "fake.cjs"), FAKE_TOOL);
  const executable = (name: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, "fake.cjs")}" ${name} "$@"\n`, {
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
  const layer = Layer.mergeAll(
    tools,
    Layer.succeed(AppLog, { write: () => Effect.void }),
    recordingDesktop(path.join(dir, "Music")).layer,
    projectsLayer("0.0.0-test"),
    settingsLayer(path.join(dir, "settings.json")),
    fakeNative,
    fakeModels,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const song = writeSong(dir, "Night Signals", {
    "song.txt": soloChart("#VIDEO:clip.mp4"),
    "Test Artist - Night Signals.mp3": syntheticBytes(4000),
    "clip.mp4": syntheticBytes(3000, 3),
  });
  const open = Effect.gen(function* () {
    return yield* importSong(yield* inspectSong(song), {
      includeVideo: true,
      target: path.join(dir, "Night.tunestudio"),
    });
  });
  /** A file of the user's, outside the project. */
  const file = (name: string, seed: number) => {
    const at = path.join(dir, name);
    fs.writeFileSync(at, syntheticBytes(2000, seed));
    return at;
  };
  return { dir, layer, open, file };
}

const roles = (rows: { role: string; fileName: string; source: string }[]) =>
  rows.map((row) => [row.role, row.fileName, row.source]);

describe("song media", () => {
  it.effect("replaces the song as it is, named for export, and only with audio", () => {
    const { dir, layer, open, file } = setup();
    return Effect.gen(function* () {
      const session = yield* open;
      const song = file("New Master.M4A", 5);
      yield* replaceSongMedia(session, "audio", song);
      const rows = yield* listMedia(session.db);
      const audio = rows.filter((row) => row.role === "audio");
      expect(roles(audio)).toEqual([["audio", "Test Artist - Night Signals.m4a", "chosen"]]);
      const copy = path.join(dir, "copy");
      yield* writeMediaToFile(session.db, audio[0]!, copy);
      expect(fs.readFileSync(copy).equals(fs.readFileSync(song))).toBe(true);

      const error = yield* Effect.flip(replaceSongMedia(session, "vocals", file("notes.txt", 6)));
      expect(error).toMatchObject({ _tag: "MediaUnreadable", message: expect.stringContaining("as audio") });
      const notVideo = yield* Effect.flip(replaceSongMedia(session, "video", file("song.mp3", 7)));
      expect(notVideo).toMatchObject({ _tag: "MediaUnreadable", message: expect.stringContaining("a video") });
    }).pipe(Effect.provide(layer));
  });

  it.effect("replaces and removes the video", () => {
    const { layer, open, file } = setup();
    return Effect.gen(function* () {
      const session = yield* open;
      yield* replaceSongMedia(session, "video", file("Live.mp4", 8));
      expect(roles((yield* listMedia(session.db)).filter((row) => row.role === "video"))).toEqual([
        ["video", "Test Artist - Night Signals.mp4", "chosen"],
      ]);
      yield* removeVideo(session);
      expect((yield* listMedia(session.db)).map((row) => row.role)).toEqual(["audio"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("separates the vocals and music from the song again, in place of those there were", () => {
    const { layer, open, file } = setup();
    return Effect.gen(function* () {
      const session = yield* open;
      yield* replaceSongMedia(session, "vocals", file("my vocals.mp3", 9));
      yield* separateSong(session);
      const stems = (yield* listMedia(session.db)).filter((row) => row.role !== "audio" && row.role !== "video");
      expect(roles(stems)).toEqual([
        ["vocals", "Test Artist - Night Signals [VOC].m4a", "generated"],
        ["instrumental", "Test Artist - Night Signals [INSTR].m4a", "generated"],
      ]);
    }).pipe(Effect.provide(layer));
  });
});
