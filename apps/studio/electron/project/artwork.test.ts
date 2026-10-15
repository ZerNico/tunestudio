import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AppLog } from "../services/app-log";
import { recordingDesktop, soloChart, syntheticBytes, tempDir, writeSong } from "../testing";
import { Downloads } from "../tools/downloads";
import { Tools } from "../tools/tools";
import { importSong, inspectSong } from "../ultrastar/song-import";
import { setArtwork } from "./artwork";
import { listMedia, writeMediaToFile } from "./media";
import { projectsLayer } from "./projects";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

/** A JPEG as far as the image check reads it. */
const jpeg = (seed: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), syntheticBytes(500, seed)]);

/** An FFmpeg that writes a fake JPEG to its last argument (the frame). */
const FAKE_FFMPEG = `
const fs = require("node:fs");
fs.writeFileSync(process.argv.at(-1), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
`;

function setup(video: boolean) {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  fs.writeFileSync(path.join(dir, "ffmpeg.cjs"), FAKE_FFMPEG);
  const ffmpeg = path.join(dir, "ffmpeg");
  fs.writeFileSync(ffmpeg, `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, "ffmpeg.cjs")}" "$@"\n`, {
    mode: 0o755,
  });
  const tools = Layer.succeed(Tools, {
    folder: path.join(dir, "tools"),
    status: Effect.succeed([]),
    ensure: () => Effect.succeed({ "yt-dlp": {}, quickjs: {}, ffmpeg: { ffmpeg, ffprobe: ffmpeg } }),
    remove: () => Effect.void,
  });
  const layer = Layer.mergeAll(
    tools,
    Layer.succeed(AppLog, { write: () => Effect.void }),
    recordingDesktop(path.join(dir, "Music")).layer,
    projectsLayer("0.0.0-test"),
    // Found covers aren't downloaded here.
    Layer.succeed(Downloads, { file: () => Effect.die("no downloads in tests") } as never),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const song = writeSong(dir, "Night Signals", {
    "song.txt": soloChart(video ? "#VIDEO:clip.mp4" : ""),
    "Test Artist - Night Signals.mp3": syntheticBytes(4000),
    "Test Artist - Night Signals [CO].jpg": jpeg(1),
    ...(video ? { "clip.mp4": syntheticBytes(3000, 3) } : {}),
  });
  const open = Effect.gen(function* () {
    return yield* importSong(yield* inspectSong(song), {
      includeVideo: true,
      target: path.join(dir, "Night.tunestudio"),
    });
  });
  return { dir, layer, open };
}

describe("artwork", () => {
  it.effect("replaces the cover with a picked image, named for export, and removes it", () => {
    const { dir, layer, open } = setup(false);
    return Effect.gen(function* () {
      const session = yield* open;
      const picked = path.join(dir, "picked.jpg");
      fs.writeFileSync(picked, jpeg(2));
      yield* setArtwork(session, "cover", { kind: "file", path: picked });
      const covers = (yield* listMedia(session.db)).filter((row) => row.role === "cover");
      expect(covers.map((row) => [row.fileName, row.source])).toEqual([
        ["Test Artist - Night Signals [CO].jpg", "chosen"],
      ]);
      const out = path.join(dir, "out.jpg");
      yield* writeMediaToFile(session.db, covers[0]!, out);
      expect(fs.readFileSync(out).equals(jpeg(2))).toBe(true);

      yield* setArtwork(session, "cover", { kind: "none" });
      expect((yield* listMedia(session.db)).some((row) => row.role === "cover")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a file that isn't an image and keeps the cover", () => {
    const { dir, layer, open } = setup(false);
    return Effect.gen(function* () {
      const session = yield* open;
      const notes = path.join(dir, "notes.txt");
      fs.writeFileSync(notes, "hello");
      const error = yield* Effect.flip(setArtwork(session, "cover", { kind: "file", path: notes }));
      expect(error.message).toBe("“notes.txt” isn't a JPEG or PNG image.");
      expect((yield* listMedia(session.db)).filter((row) => row.role === "cover")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});
