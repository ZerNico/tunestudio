import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ImportProgress } from "../../src/lib/native/types";
import { ChartUnreadable, MissingMainAudio, NoChartFound, ProjectNotOpen } from "../errors";
import { readChart } from "../project/chart";
import { readMeta } from "../project/database";
import { listMedia, writeMediaToFile } from "../project/media";
import { Projects } from "../project/projects";
import type { StudioServices } from "../services/layer";
import { soloChart, syntheticBytes, tempDir, testRuntime, writeSong } from "../testing";
import { describeSong, importSong, inspectSong } from "./song-import";

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

const audio = syntheticBytes(1_500_000, 3);
const cover = syntheticBytes(20_000, 4);

describe("inspecting a song folder", () => {
  it("finds the chart and its media and reports what's missing", async () => {
    const { dir, run } = setup();
    const folder = writeSong(dir, "Test Artist - Night Signals", {
      "Test Artist - Night Signals.txt": soloChart("#VOCALS:missing [VOC].mp3\n#BACKGROUND:../outside.jpg"),
      "Test Artist - Night Signals.mp3": audio,
      "Test Artist - Night Signals [CO].jpg": cover,
    });
    fs.writeFileSync(path.join(dir, "outside.jpg"), "private");

    const inspection = describeSong(await run(inspectSong(folder)));
    expect(inspection).toMatchObject({
      folder,
      chart: "Test Artist - Night Signals.txt",
      charts: ["Test Artist - Night Signals.txt"],
      title: "Night Signals",
      artist: "Test Artist",
      notes: 6,
      singers: 1,
      blocker: null,
      suggestedName: "Test Artist - Night Signals",
    });
    expect(inspection.media).toEqual([
      { role: "audio", fileName: "Test Artist - Night Signals.mp3", size: audio.length, found: true },
      { role: "vocals", fileName: "missing [VOC].mp3", found: false },
      { role: "cover", fileName: "Test Artist - Night Signals [CO].jpg", size: cover.length, found: true },
      { role: "background", fileName: "../outside.jpg", found: false },
    ]);
    expect(inspection.warnings).toContain("The vocals “missing [VOC].mp3” is missing, so it isn't imported.");
    expect(inspection.warnings).toContain(
      "The background “../outside.jpg” is outside the song folder, so it isn't imported.",
    );
  });

  it("accepts the chart file itself and lists the folder's other charts", async () => {
    const { dir, run } = setup();
    const folder = writeSong(dir, "Song", {
      "b.txt": soloChart(),
      "a.txt": soloChart().replace("Night Signals", "Other"),
      "Test Artist - Night Signals.mp3": audio,
    });
    const fromFile = describeSong(await run(inspectSong(path.join(folder, "b.txt"))));
    expect(fromFile).toMatchObject({ chart: "b.txt", charts: ["a.txt", "b.txt"], title: "Night Signals" });
    const picked = describeSong(await run(inspectSong(folder, "a.txt")));
    expect(picked).toMatchObject({ chart: "a.txt", title: "Other" });
  });

  it("decodes Windows-1252 charts, declared or not", async () => {
    const { dir, run } = setup();
    const latin1 = (text: string) => Buffer.from(text, "latin1");
    const declared = writeSong(dir, "Declared", {
      "song.txt": latin1(soloChart("#ENCODING:CP1252").replace("Night Signals", "Gr\xfc\xdfe")),
      "Test Artist - Night Signals.mp3": audio,
    });
    const undeclared = writeSong(dir, "Undeclared", {
      "song.txt": latin1(soloChart().replace("Night Signals", "Caf\xe9")),
      "Test Artist - Night Signals.mp3": audio,
    });
    expect(describeSong(await run(inspectSong(declared))).title).toBe("Grüße");
    expect(describeSong(await run(inspectSong(undeclared))).title).toBe("Café");
  });

  it("explains folders without a chart, unreadable charts and unsupported encodings", async () => {
    const { dir, run } = setup();
    const empty = writeSong(dir, "Empty", { "song.mp3": audio });
    const broken = writeSong(dir, "Broken", { "song.txt": "#TITLE:x\n#BPM:120\n: 0 0 0 zero\nE\n" });
    const encoding = writeSong(dir, "Encoding", { "song.txt": "#ENCODING:KLINGON\n#BPM:120\nE\n" });

    const noChart = await run(Effect.flip(inspectSong(empty)));
    expect(noChart).toBeInstanceOf(NoChartFound);
    expect(noChart.message).toBe("“Empty” has no UltraStar chart (.txt file).");
    const unreadable = await run(Effect.flip(inspectSong(broken)));
    expect(unreadable).toBeInstanceOf(ChartUnreadable);
    expect(unreadable.message).toMatch(/^Couldn't read “song.txt”: Line 3: A note has no length/);
    const unsupported = await run(Effect.flip(inspectSong(encoding)));
    expect(unsupported.message).toBe("Couldn't read “song.txt”: The chart's encoding “KLINGON” isn't supported.");
  });

  it("blocks charts without their main audio", async () => {
    const { dir, run } = setup();
    const missing = writeSong(dir, "Missing", { "song.txt": soloChart() });
    const unnamed = writeSong(dir, "Unnamed", { "song.txt": soloChart().replace(/#MP3:.*\n/, "") });
    expect(describeSong(await run(inspectSong(missing))).blocker).toBe(
      "The audio file “Test Artist - Night Signals.mp3” is missing from the song folder.",
    );
    expect(describeSong(await run(inspectSong(unnamed))).blocker).toMatch(/doesn't name an audio file/);
    const error = await run(
      Effect.flip(
        Effect.flatMap(inspectSong(missing), (source) =>
          importSong(source, { includeVideo: true, target: path.join(dir, "x.tunestudio") }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(MissingMainAudio);
    expect(fs.existsSync(path.join(dir, "x.tunestudio"))).toBe(false);
  });
});

describe("importing a song", () => {
  it("writes the chart, details, unknown headers and media into a new project", async () => {
    const { dir, run } = setup();
    const video = syntheticBytes(2_200_000, 5);
    const folder = writeSong(dir, "Song", {
      "song.txt": soloChart("#VIDEO:clip.mp4\n#VIDEOGAP:0,5\n#ENCODING:UTF8\n#VERSION:1.0.0"),
      "Test Artist - Night Signals.mp3": audio,
      "Test Artist - Night Signals [CO].jpg": cover,
      "clip.mp4": video,
    });
    const target = path.join(dir, "Projects", "Night Signals.tunestudio");
    fs.mkdirSync(path.dirname(target));
    const progress: ImportProgress[] = [];

    const result = await run(
      Effect.gen(function* () {
        const source = yield* inspectSong(folder);
        const session = yield* importSong(source, { includeVideo: true, target }, (step) =>
          Effect.sync(() => void progress.push(step)),
        );
        const chart = yield* readChart(session.db);
        const media = yield* listMedia(session.db);
        const meta = yield* readMeta(session.db);
        const copies: Buffer[] = [];
        for (const row of media) {
          const out = path.join(dir, `copy-${row.id}`);
          yield* writeMediaToFile(session.db, row, out);
          copies.push(fs.readFileSync(out));
        }
        return { session, chart, media, meta, copies };
      }),
    );

    expect(result.session.path).toBe(target);
    expect(fs.readdirSync(path.dirname(target))).toEqual(["Night Signals.tunestudio"]);
    expect(result.chart.song).toEqual({
      title: "Night Signals",
      artist: "Test Artist",
      language: ["English", "German"],
      year: 2024,
      youtubeId: null,
      genre: "Pop",
      edition: null,
      creator: "Tune Studio tests",
      bpm: 240,
      gap: 1.2505,
      videoGap: 0.5,
      start: null,
      end: null,
      previewStart: 12.5,
      medleyStart: null,
      medleyEnd: null,
      extraHeaders: [
        ["X-CUSTOM", "keep: me"],
        ["TAGS", "synthetic, test"],
      ],
    });
    expect(result.chart.singers).toHaveLength(1);
    const [first, second] = result.chart.singers[0]!.lines;
    expect(first!.notes.map((note) => note.lyric)).toEqual(["Hel", "lo ", "world"]);
    expect(first!.switchStart).toBeCloseTo(1.2505 + 18 * (15 / 240), 10);
    expect(second!.notes.map((note) => [note.type, note.pitch])).toEqual([
      ["freestyle", 60],
      ["rap", 60],
      ["normal", 57],
    ]);
    expect(result.media.map((row) => [row.role, row.fileName, row.size])).toEqual([
      ["audio", "Test Artist - Night Signals.mp3", audio.length],
      ["video", "clip.mp4", video.length],
      ["cover", "Test Artist - Night Signals [CO].jpg", cover.length],
    ]);
    expect(result.copies.map((copy, index) => copy.equals([audio, video, cover][index]!))).toEqual([true, true, true]);
    expect(result.meta.imported_from).toBe(path.join(folder, "song.txt"));
    expect(JSON.parse(result.meta.import_warnings!)).toEqual([]);
    expect(progress.at(0)).toEqual({
      step: "Reading song.txt",
      done: 0,
      total: audio.length + video.length + cover.length,
    });
    expect(progress.at(-1)).toEqual({ step: "Finishing", done: progress.at(0)!.total, total: progress.at(0)!.total });
    expect(progress.some((step) => step.step === "Copying clip.mp4")).toBe(true);
    // The song folder is only read.
    expect(fs.readdirSync(folder).toSorted()).toEqual([
      "Test Artist - Night Signals [CO].jpg",
      "Test Artist - Night Signals.mp3",
      "clip.mp4",
      "song.txt",
    ]);
  });

  it("leaves the video out when asked, and keeps USDB-style #VIDEO metadata as a header, with its YouTube video", async () => {
    const { dir, run } = setup();
    const withVideo = writeSong(dir, "With video", {
      "song.txt": soloChart("#VIDEO:clip.mp4"),
      "Test Artist - Night Signals.mp3": audio,
      "clip.mp4": syntheticBytes(10, 1),
    });
    const metadata = writeSong(dir, "Metadata", {
      "song.txt": soloChart("#VIDEO:v=dQw4w9WgXcQ,co=cover.jpg"),
      "Test Artist - Night Signals.mp3": audio,
    });
    const roles = await run(
      Effect.gen(function* () {
        const session = yield* importSong(yield* inspectSong(withVideo), {
          includeVideo: false,
          target: path.join(dir, "a.tunestudio"),
        });
        return (yield* listMedia(session.db)).map((row) => row.role);
      }),
    );
    expect(roles).toEqual(["audio"]);

    const kept = await run(
      Effect.gen(function* () {
        const source = yield* inspectSong(metadata);
        expect(source.warnings.filter((warning) => warning.includes("video"))).toEqual([]);
        const session = yield* importSong(source, { includeVideo: true, target: path.join(dir, "b.tunestudio") });
        return (yield* readChart(session.db)).song;
      }),
    );
    expect(kept.extraHeaders).toContainEqual(["VIDEO", "v=dQw4w9WgXcQ,co=cover.jpg"]);
    // usdb_syncer's video becomes the song's YouTube video.
    expect(kept.youtubeId).toBe("dQw4w9WgXcQ");
  });

  it("imports duets with singer names and keeps import warnings with the project", async () => {
    const { dir, run } = setup();
    const chart = [
      "#TITLE:Duet",
      "#ARTIST:Two Voices",
      "#AUDIO:duet.ogg",
      "#P1:Low voice",
      "#DUETSINGERP2:High voice",
      "#BPM:300",
      "#GAP:0",
      "#YEAR:soon",
      "P1",
      ": 0 4 0 one ",
      "- 6",
      ": 8 4 2 two",
      "P2",
      ": 2 4 7 three",
      "E",
    ].join("\r\n");
    const folder = writeSong(dir, "Duet", { "duet.txt": chart, "duet.ogg": audio });
    const { singers, song, meta } = await run(
      Effect.gen(function* () {
        const session = yield* importSong(yield* inspectSong(folder), {
          includeVideo: true,
          target: path.join(dir, "duet.tunestudio"),
        });
        const read = yield* readChart(session.db);
        return { ...read, meta: yield* readMeta(session.db) };
      }),
    );
    expect(singers.map((singer) => [singer.index, singer.name, singer.lines.length])).toEqual([
      [1, "Low voice", 2],
      [2, "High voice", 1],
    ]);
    expect(song.year).toBeNull();
    expect(song.extraHeaders).toEqual([["YEAR", "soon"]]);
    expect(JSON.parse(meta.import_warnings!)).toEqual(["#YEAR “soon” isn't a year. It was kept as it is."]);
  });

  it("removes the half-written file when the import fails or is interrupted", async () => {
    const { dir, run } = setup();
    const folder = writeSong(dir, "Song", {
      "song.txt": soloChart(),
      "Test Artist - Night Signals.mp3": audio,
    });
    const target = path.join(dir, "out", "Song.tunestudio");
    fs.mkdirSync(path.dirname(target));
    await run(
      Effect.gen(function* () {
        const source = yield* inspectSong(folder);
        yield* importSong(source, { includeVideo: true, target }, () => Effect.interrupt).pipe(Effect.exit);
      }),
    );
    expect(fs.readdirSync(path.dirname(target))).toEqual([]);
  });

  it("replaces an existing project file and reopens it", async () => {
    const { dir, run } = setup();
    const folder = writeSong(dir, "Song", { "song.txt": soloChart(), "Test Artist - Night Signals.mp3": audio });
    const target = path.join(dir, "Song.tunestudio");
    const ids = await run(
      Effect.gen(function* () {
        const source = yield* inspectSong(folder);
        const first = yield* importSong(source, { includeVideo: true, target });
        const second = yield* importSong(source, { includeVideo: true, target });
        const projects = yield* Projects;
        const closed = yield* Effect.flip(projects.get(first.id));
        return { first: first.id, second: second.id, closed: closed instanceof ProjectNotOpen };
      }),
    );
    expect(ids.first).not.toBe(ids.second);
    expect(ids.closed).toBe(true);
  });
});
