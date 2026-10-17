import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { FINDING_THE_PITCH } from "../../src/lib/steps";
import { readEditorChart } from "../project/editor-chart";
import { sungPitch } from "../project/pitch";
import { projectsLayer } from "../project/projects";
import { analysis } from "../project/schema";
import { AppLog } from "../services/app-log";
import { fakeModels, fakeNative, recordingDesktop, soloChart, syntheticBytes, tempDir, writeSong } from "../testing";
import { Tools } from "../tools/tools";
import { importSong, inspectSong } from "../ultrastar/song-import";
import { chartLanguage } from "./generate";
import { autoPitchNotes } from "./project-auto-pitch";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

/** An FFmpeg that "decodes" any file to five seconds of an A3 tone at the requested rate (raw f32le, last argument). */
const FAKE_FFMPEG = `
const fs = require("node:fs");
const args = process.argv.slice(2);
const rate = Number(args[args.indexOf("-ar") + 1]);
const samples = new Float32Array(rate * 5).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate));
fs.writeFileSync(args.at(-1), Buffer.from(samples.buffer));
`;

function setup() {
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
  const log = Layer.succeed(AppLog, { write: () => Effect.void });
  const layer = Layer.mergeAll(
    tools,
    log,
    recordingDesktop(path.join(dir, "Music")).layer,
    projectsLayer("0.0.0-test"),
    fakeNative,
    fakeModels,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const song = writeSong(dir, "Night Signals", {
    "song.txt": soloChart("#VOCALS:vocals.m4a").replace("#LANGUAGE:English, German", "#LANGUAGE:English"),
    "Test Artist - Night Signals.mp3": syntheticBytes(4000),
    "vocals.m4a": syntheticBytes(3000, 2),
  });
  return { dir, layer, song };
}

describe("chartLanguage", () => {
  it("supports English and German so far", () => {
    expect(chartLanguage(["German", "English"])).toEqual({ name: "german", code: "deu" });
    expect(chartLanguage(["Korean (romanized)"])).toBe(
      "Charts can't be made in Korean (romanized) yet, only in English and German.",
    );
    expect(chartLanguage([])).toBe("Set the song's language first.");
  });
});

describe("sungPitch", () => {
  it.effect("follows the melody of the vocals once and keeps it in the project", () => {
    const { dir, layer, song } = setup();
    return Effect.gen(function* () {
      const session = yield* importSong(yield* inspectSong(song), {
        includeVideo: false,
        target: path.join(dir, "Night.tunestudio"),
      });
      const steps: string[] = [];
      const pitch = yield* sungPitch(session, (progress) => Effect.sync(() => void steps.push(progress.step)));
      // Five seconds every 10 ms; the fake model hears A4 throughout.
      expect(pitch?.hop).toBe(0.01);
      expect(pitch?.midi.length).toBe(501);
      expect(pitch?.midi[250]).toBe(69);
      expect(steps).toContain("Following the melody");
      // Asked again, it comes from the project.
      const again = yield* sungPitch(session, (progress) => Effect.sync(() => void steps.push(progress.step)));
      expect(again).toEqual(pitch);
      expect(steps.filter((step) => step === "Following the melody")).toHaveLength(1);
      const rows = yield* session.db.select().from(analysis).pipe(Effect.orDie);
      expect(rows.filter((row) => row.kind === "pitch")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});

describe("autoPitchNotes", () => {
  it.effect("finds the sung pitch of a line's notes from the project's vocals", () => {
    const { dir, layer, song } = setup();
    return Effect.gen(function* () {
      const session = yield* importSong(yield* inspectSong(song), {
        includeVideo: false,
        target: path.join(dir, "Night.tunestudio"),
      });
      const [first] = (yield* readEditorChart(session.db)).singers[0]!.lines;
      const ids = first!.notes.map((note) => note.id);
      const steps: string[] = [];
      const pitches = yield* autoPitchNotes(session, ids, (progress) =>
        Effect.sync(() => void steps.push(progress.step)),
      );
      // The fake models hear A4 throughout.
      expect(pitches).toEqual(ids.map((id) => ({ id, pitch: 69 })));
      expect(steps).toContain(FINDING_THE_PITCH);
      // Notes that aren't there: nothing to do.
      expect(yield* autoPitchNotes(session, [999_999], () => Effect.void)).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
