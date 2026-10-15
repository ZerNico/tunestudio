import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { parseUltraStar } from "@tunestudio/ultrastar";
import { Effect } from "effect";

import { PermissionDenied } from "../errors";
import { readChart } from "../project/chart";
import type { StudioServices } from "../services/layer";
import { soloChart, syntheticBytes, tempDir, testRuntime, writeSong } from "../testing";
import { exportFileNames, exportSong } from "./song-export";
import { importSong, inspectSong } from "./song-import";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups = [];
});

function setup() {
  const { dir, cleanup } = tempDir();
  const { runtime } = testRuntime(dir);
  cleanups.push(cleanup, () => runtime.dispose());
  return { dir, run: <A, E>(effect: Effect.Effect<A, E, StudioServices>) => runtime.runPromise(effect) };
}

const audio = syntheticBytes(2 * 1024 * 1024 + 123, 11);
const vocals = syntheticBytes(700_001, 12);
const cover = syntheticBytes(33_333, 13);
const background = syntheticBytes(44_444, 14);

const duetChart = [
  "#TITLE:Under/Over",
  "#ARTIST:Two Voices",
  "#AUDIO:mix.m4a",
  "#VOCALS:vocals.mp3",
  "#COVER:front.jpg",
  "#BACKGROUND:back.png",
  "#P1:Low voice",
  "#P2:High voice",
  "#BPM:312,5",
  "#GAP:-250,5",
  "#END:61000",
  "#MEDLEYSTARTBEAT:8",
  "#MEDLEYENDBEAT:40",
  "#COMMENT:kept",
  "P1",
  ": 0 4 0 one ",
  "- 6 7",
  ": 8 4 2 two",
  "P2",
  ": 2 4 7 thr",
  ": 6 4 7 ee",
  "- 12",
  "G 14 2 5 rap",
  "E",
].join("\n");

describe("exporting an UltraStar song", () => {
  it("round-trips: import, export and import again give the same chart and identical media", async () => {
    const { dir, run } = setup();
    const folder = writeSong(dir, "Original", {
      "duet.txt": duetChart,
      "mix.m4a": audio,
      "vocals.mp3": vocals,
      "front.jpg": cover,
      "back.png": background,
    });
    const exportDir = path.join(dir, "Exports");
    fs.mkdirSync(exportDir);

    const { first, second, result } = await run(
      Effect.gen(function* () {
        const imported = yield* importSong(yield* inspectSong(folder), {
          includeVideo: true,
          target: path.join(dir, "duet.tunestudio"),
        });
        const result = yield* exportSong(imported, exportDir, false);
        if (result.status !== "exported") throw new Error("expected an export");
        const again = yield* importSong(yield* inspectSong(result.folder), {
          includeVideo: true,
          target: path.join(dir, "again.tunestudio"),
        });
        return { first: yield* readChart(imported.db), second: yield* readChart(again.db), result };
      }),
    );

    const name = "Two Voices - Under_Over";
    expect(result.folder).toBe(path.join(exportDir, name));
    expect(result.files).toEqual([
      `${name}.txt`,
      `${name}.m4a`,
      `${name} [VOC].mp3`,
      `${name} [CO].jpg`,
      `${name} [BG].png`,
    ]);
    expect(fs.readdirSync(exportDir)).toEqual([name]);
    expect(fs.readdirSync(result.folder).toSorted()).toEqual(result.files.toSorted());
    const exported = (file: string) => fs.readFileSync(path.join(result.folder, file));
    expect(exported(`${name}.m4a`).equals(audio)).toBe(true);
    expect(exported(`${name} [VOC].mp3`).equals(vocals)).toBe(true);
    expect(exported(`${name} [CO].jpg`).equals(cover)).toBe(true);
    expect(exported(`${name} [BG].png`).equals(background)).toBe(true);

    const text = exported(`${name}.txt`).toString("utf8");
    expect(text.split("\n").slice(0, 21)).toEqual([
      "#VERSION:1.2.0",
      "#TITLE:Under/Over",
      "#ARTIST:Two Voices",
      "#P1:Low voice",
      "#P2:High voice",
      `#AUDIO:${name}.m4a`,
      `#MP3:${name}.m4a`,
      `#VOCALS:${name} [VOC].mp3`,
      `#COVER:${name} [CO].jpg`,
      `#BACKGROUND:${name} [BG].png`,
      "#BPM:312.5",
      "#GAP:-250.5",
      "#END:61000",
      "#MEDLEYSTARTBEAT:8",
      "#MEDLEYENDBEAT:40",
      "#COMMENT:kept",
      "P1",
      ": 0 4 0 one ",
      "- 6 7",
      ": 8 4 2 two",
      "P2",
    ]);
    // The project chart has no IDs: equal rows mean the same chart.
    expect(second).toEqual(first);
    expect(parseUltraStar(text).document.notes).toHaveLength(5);
  });

  it("asks before replacing an existing export, then replaces it in one step", async () => {
    const { dir, run } = setup();
    const folder = writeSong(dir, "Song", { "song.txt": soloChart(), "Test Artist - Night Signals.mp3": audio });
    const exportDir = path.join(dir, "Exports");
    const existing = path.join(exportDir, "Test Artist - Night Signals");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "old.txt"), "old");

    const [first, second] = await run(
      Effect.gen(function* () {
        const session = yield* importSong(yield* inspectSong(folder), {
          includeVideo: true,
          target: path.join(dir, "song.tunestudio"),
        });
        return [yield* exportSong(session, exportDir, false), yield* exportSong(session, exportDir, true)] as const;
      }),
    );
    expect(first).toEqual({ status: "exists", folder: existing });
    expect(second.status).toBe("exported");
    expect(fs.readdirSync(exportDir)).toEqual(["Test Artist - Night Signals"]);
    expect(fs.readdirSync(existing).toSorted()).toEqual([
      "Test Artist - Night Signals.mp3",
      "Test Artist - Night Signals.txt",
    ]);
  });

  it("leaves an existing export as it was when writing fails", async () => {
    const { dir, run } = setup();
    const folder = writeSong(dir, "Song", { "song.txt": soloChart(), "Test Artist - Night Signals.mp3": audio });
    const exportDir = path.join(dir, "Exports");
    const existing = path.join(exportDir, "Test Artist - Night Signals");
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, "old.txt"), "old");
    const error = await run(
      Effect.gen(function* () {
        const session = yield* importSong(yield* inspectSong(folder), {
          includeVideo: true,
          target: path.join(dir, "song.tunestudio"),
        });
        fs.chmodSync(exportDir, 0o500);
        return yield* Effect.flip(exportSong(session, exportDir, true));
      }).pipe(Effect.ensuring(Effect.sync(() => fs.chmodSync(exportDir, 0o700)))),
    );
    expect(error).toBeInstanceOf(PermissionDenied);
    expect(fs.readdirSync(exportDir)).toEqual(["Test Artist - Night Signals"]);
    expect(fs.readdirSync(existing)).toEqual(["old.txt"]);
  });

  it("names media after the song, and keeps audio and video apart when they share an extension", () => {
    const names = exportFileNames("A - B", [
      { id: 1, role: "audio", fileName: "x.webm" },
      { id: 2, role: "video", fileName: "y.WEBM" },
      { id: 3, role: "cover", fileName: "c.jpeg" },
      { id: 4, role: "cover", fileName: "second.jpg" },
      { id: 5, role: "instrumental", fileName: "noext" },
    ]);
    expect([...names.entries()]).toEqual([
      [1, "A - B.webm"],
      [2, "A - B [VIDEO].WEBM"],
      [3, "A - B [CO].jpeg"],
      [5, "A - B [INSTR]"],
    ]);
  });
});
