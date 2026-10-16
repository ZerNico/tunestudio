import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { tempDir } from "../testing";
import type { ProjectChart } from "../ultrastar/chart-mapping";
import { writeChart } from "./chart";
import { createDatabase } from "./database";
import { readEditorChart } from "./editor-chart";
import { migrations } from "./migrations.gen";

let cleanup = () => {};
afterEach(() => cleanup());

const note = (start: number, lyric: string, pitch = 64) => ({
  start,
  duration: 0.3,
  pitch,
  lyric,
  type: "normal" as const,
});

/** A duet: P1 with two lines, P2 with one. */
const duet: ProjectChart = {
  song: {
    title: "Song",
    artist: "Artist",
    language: ["English"],
    year: null,
    genre: null,
    edition: null,
    creator: null,
    bpm: 300,
    gap: 1.5,
    videoGap: null,
    start: null,
    end: null,
    previewStart: null,
    medleyStart: null,
    medleyEnd: null,
    extraHeaders: [],
    youtubeId: null,
    youtubeAudioId: null,
  },
  singers: [
    {
      index: 2,
      name: "Bea",
      lines: [{ switchStart: null, switchEnd: null, notes: [note(4, "Hel", 67), note(4.4, "lo ")] }],
    },
    {
      index: 1,
      name: "Al",
      lines: [
        { switchStart: 2.6, switchEnd: null, notes: [note(1.5, "We "), note(1.9, "walk ")] },
        { switchStart: null, switchEnd: null, notes: [note(3, "a"), note(3.4, "long")] },
      ],
    },
  ],
};

describe("readEditorChart", () => {
  it.effect("reads singers, lines and notes in order, with their ids and the export grid", () => {
    const made = tempDir();
    cleanup = made.cleanup;
    const file = path.join(made.dir, "Song.tunestudio");
    return Effect.scoped(
      Effect.gen(function* () {
        const db = yield* createDatabase(file, "Song.tunestudio", "1.0.0", "project-1", migrations);
        yield* writeChart(db, duet);
        const chart = yield* readEditorChart(db);
        expect(chart.bpm).toBe(300);
        expect(chart.gap).toBe(1.5);
        expect(chart.singers.map((singer) => [singer.index, singer.name])).toEqual([
          [1, "Al"],
          [2, "Bea"],
        ]);
        const [al, bea] = chart.singers;
        expect(al!.lines.map((line) => line.notes.map((n) => n.lyric).join(""))).toEqual(["We walk ", "along"]);
        expect(al!.lines[0]!.switchStart).toBe(2.6);
        expect(bea!.lines[0]!.notes[0]).toMatchObject({ start: 4, pitch: 67, type: "normal", edited: false });
        // Every row has its own id, for edits to address.
        const ids = chart.singers.flatMap((s) => s.lines.flatMap((l) => [l.id, ...l.notes.map((n) => n.id)]));
        expect(ids.every((id) => Number.isInteger(id))).toBe(true);
        expect(new Set(chart.singers.flatMap((s) => s.lines.flatMap((l) => l.notes.map((n) => n.id)))).size).toBe(6);
      }),
    );
  });
});
