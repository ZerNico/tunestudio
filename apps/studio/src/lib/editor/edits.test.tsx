import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import type { EditorChart, NoteType } from "~/lib/native/types";

import { createChartDocument } from "./document";
import {
  addNote,
  canSplit,
  defaultLength,
  deleteNotes,
  lineAt,
  splitNote,
  fits,
  gridStep,
  lengthLimits,
  mergeNotes,
  moveLimits,
  moveNotes,
  onGrid,
  overlapping,
  pitchFits,
  pitchLimits,
  placeNotes,
  resizeNotes,
  resizeStarts,
  snapDelta,
  startLimits,
  shiftPitch,
  toggleFlag,
} from "./edits";
import { testSong } from "./test-song";

const note = (id: number, start: number, lyric: string, duration = 0.3, type: NoteType = "normal") => ({
  id,
  start,
  duration,
  pitch: 64,
  lyric,
  type,
  edited: false,
});

/** Grid: 0.05 s steps from 1 s. Line 10 ends at a stored break at 2.5 s. */
const chart: EditorChart = {
  bpm: 300,
  gap: 1,
  song: testSong,
  singers: [
    {
      id: 1,
      index: 1,
      name: null,
      lines: [
        {
          id: 10,
          switchStart: 2.5,
          switchEnd: null,
          notes: [note(100, 1, "We "), note(101, 1.5, "wa"), note(102, 1.8, "~lk ")],
        },
        { id: 11, switchStart: null, switchEnd: null, notes: [note(103, 3, "on")] },
      ],
    },
  ],
};

function setup() {
  return createRoot(() => {
    const [selection, setSelection] = createSignal<number[]>([]);
    const doc = createChartDocument<number[]>({
      chart,
      save: async () => {},
      onFailed: () => {},
      selection,
      setSelection,
    });
    return doc;
  });
}

const notesOf = (value: EditorChart) => value.singers.flatMap((singer) => singer.lines.flatMap((line) => line.notes));
const find = (value: EditorChart, id: number) => notesOf(value).find((item) => item.id === id);

describe("grid", () => {
  it("steps 15 / BPM seconds from the gap", () => {
    expect(gridStep(chart)).toBeCloseTo(0.05);
    expect(onGrid(chart, 1.123)).toBeCloseTo(1.1);
  });
});

describe("limits", () => {
  const placed = placeNotes(chart, 10);

  it("lets notes move up to a stored break and the song's start, through other notes", () => {
    expect(moveLimits(placed, new Set([101]))).toEqual({ min: -1.5, max: expect.closeTo(0.7) });
    expect(moveLimits(placed, new Set([103]))).toEqual({ min: -0.5, max: expect.closeTo(6.7) });
  });

  it("keeps notes at least a step long, and their end before the break", () => {
    const limits = lengthLimits(placed, new Set([102]), gridStep(chart));
    expect(limits.min).toBeCloseTo(-0.25);
    expect(limits.max).toBeCloseTo(0.4);
    expect(fits(0.4, limits)).toBe(true);
    expect(fits(0.45, limits)).toBe(false);
  });

  it("keeps starts after the break before them, and notes a step long", () => {
    const limits = startLimits(placeNotes(chart, 10), new Set([103]), gridStep(chart));
    expect(limits.min).toBeCloseTo(-0.5);
    expect(limits.max).toBeCloseTo(0.25);
  });

  it("snaps a drag to whole steps within the limits", () => {
    expect(snapDelta(0.12, 0.05, { min: -1, max: 1 })).toBeCloseTo(0.1);
    expect(snapDelta(0.9, 0.05, { min: -1, max: 0.32 })).toBeCloseTo(0.3);
    expect(snapDelta(-3, 1, { min: -2, max: 5 })).toBe(-2);
    expect(snapDelta(1, 0.05, { min: 0.01, max: 0.04 })).toBe(0);
  });

  it("knows how far the pitch can go", () => {
    expect(pitchLimits(chart, new Set([100]))).toEqual({ min: -64, max: 63 });
  });

  it("keeps the pitch within MIDI", () => {
    expect(pitchFits(chart, new Set([100]), 63)).toBe(true);
    expect(pitchFits(chart, new Set([100]), 64)).toBe(false);
    expect(pitchFits(chart, new Set([100]), -65)).toBe(false);
  });
});

describe("edits", () => {
  it("moves, resizes and repitches on the grid, marking the notes edited", () => {
    const doc = setup();
    doc.edit("Move", (tx) => {
      moveNotes(tx, chart, [100, 101], 0.05);
      resizeNotes(tx, chart, [102], -0.1);
      shiftPitch(tx, [103], 12);
    });
    flush();
    expect(find(doc.chart(), 100)).toMatchObject({ start: expect.closeTo(1.05, 9), edited: true });
    expect(find(doc.chart(), 101)!.start).toBeCloseTo(1.55, 9);
    expect(find(doc.chart(), 102)!.duration).toBeCloseTo(0.2, 9);
    expect(find(doc.chart(), 103)).toMatchObject({ pitch: 76, edited: true });
  });

  it("moves a start while the end stays", () => {
    const doc = setup();
    doc.edit("Start", (tx) => resizeStarts(tx, chart, [103], 0.1));
    flush();
    expect(find(doc.chart(), 103)).toMatchObject({ start: expect.closeTo(3.1, 9), duration: expect.closeTo(0.2, 9) });
  });

  it("finds notes that overlap, as many as there are", () => {
    expect(overlapping(chart)).toEqual(new Set());
    const doc = setup();
    doc.edit("Move", (tx) => moveNotes(tx, chart, [101], 0.2));
    flush();
    expect(overlapping(doc.chart())).toEqual(new Set([101, 102]));
  });

  it("deletes notes, and a line left empty", () => {
    const doc = setup();
    doc.edit("Delete", (tx) => deleteNotes(tx, chart, new Set([101, 103])));
    flush();
    expect(doc.chart().singers[0]!.lines.map((line) => line.notes.map((item) => item.id))).toEqual([[100, 102]]);
  });

  it("merges notes next to each other in a line, joining the syllables without the held vowel's ~", () => {
    const doc = setup();
    let merged: number | null = null;
    doc.edit("Merge", (tx) => (merged = mergeNotes(tx, chart, new Set([101, 102]))));
    flush();
    expect(merged).toBe(101);
    expect(find(doc.chart(), 101)).toMatchObject({ start: 1.5, duration: expect.closeTo(0.6), lyric: "walk " });
    expect(find(doc.chart(), 102)).toBeUndefined();
  });

  it("merges nothing with a gap in the selection or across lines", () => {
    const doc = setup();
    expect(doc.edit("Merge", (tx) => void mergeNotes(tx, chart, new Set([100, 102])))).toBe(false);
    expect(doc.edit("Merge", (tx) => void mergeNotes(tx, chart, new Set([102, 103])))).toBe(false);
  });

  it("toggles golden, rap and freestyle, combining golden and rap", () => {
    const doc = setup();
    const types = () => [100, 101].map((id) => find(doc.chart(), id)!.type);
    const toggle = (flag: "golden" | "rap" | "freestyle") => {
      doc.edit("Type", (tx) => toggleFlag(tx, doc.chart(), new Set([100, 101]), flag));
      flush();
    };
    toggle("golden");
    expect(types()).toEqual(["golden", "golden"]);
    toggle("rap");
    expect(types()).toEqual(["golden-rap", "golden-rap"]);
    toggle("freestyle");
    expect(types()).toEqual(["freestyle", "freestyle"]);
    toggle("freestyle");
    expect(types()).toEqual(["normal", "normal"]);
  });

  it("turns a flag on for all when only some have it", () => {
    const doc = setup();
    doc.edit("Type", (tx) => toggleFlag(tx, chart, new Set([100]), "golden"));
    flush();
    doc.edit("Type", (tx) => toggleFlag(tx, doc.chart(), new Set([100, 101]), "golden"));
    flush();
    expect([100, 101].map((id) => find(doc.chart(), id)!.type)).toEqual(["golden", "golden"]);
  });

  it("finds the line a time falls in, between the line breaks", () => {
    expect(lineAt(chart, 1, 0)).toBe(10);
    expect(lineAt(chart, 1, 2.4)).toBe(10);
    // The stored break is at 2.5.
    expect(lineAt(chart, 1, 2.6)).toBe(11);
    expect(lineAt(chart, 1, 9)).toBe(11);
    expect(lineAt(chart, 2, 1)).toBeNull();
  });

  it("adds a note on the grid to the line it falls in, without a syllable", () => {
    const doc = setup();
    let id: number | null = 0;
    doc.edit("Add", (tx) => (id = addNote(tx, chart, { singerId: 1, start: 3.42, duration: 0.01, pitch: 60 }, 10)));
    flush();
    const line = doc.chart().singers[0]!.lines.find((item) => item.notes.some((n) => n.id === id))!;
    expect(line.id).toBe(11);
    expect(find(doc.chart(), id)).toMatchObject({
      start: expect.closeTo(3.4, 9),
      duration: expect.closeTo(0.05, 9),
      lyric: "",
      edited: true,
    });
    expect(defaultLength(chart)).toBeCloseTo(0.15);
  });

  it("cuts a new note short at its line's stored break, and adds none where not a step fits", () => {
    const doc = setup();
    const add = (start: number, duration: number, length = 10) => {
      let id: number | null = null;
      doc.edit("Add", (tx) => (id = addNote(tx, chart, { singerId: 1, start, duration, pitch: 60 }, length)));
      flush();
      return id === null ? null : find(doc.chart(), id);
    };
    // The break after line 10 is at 2.5.
    expect(add(2.3, 0.5)).toMatchObject({ start: expect.closeTo(2.3, 9), duration: expect.closeTo(0.2, 9) });
    expect(add(2.49, 0.5)).toBeNull();
    // Not past the song's end either.
    expect(add(9.9, 0.5)).toMatchObject({ duration: expect.closeTo(0.1, 9) });
  });

  it("never starts a new note before 0", () => {
    // With the grid from 0.03 s, the grid line nearest 0 is at -0.02 s.
    const shifted = { ...chart, gap: 0.03 };
    const doc = setup();
    let id: number | null = null;
    doc.edit("Add", (tx) => (id = addNote(tx, shifted, { singerId: 1, start: 0, duration: 0.1, pitch: 60 }, 10)));
    flush();
    expect(find(doc.chart(), id!)!.start).toBeCloseTo(0.03, 9);
  });

  it("keeps lines apart at a default break: up to the next line's first note", () => {
    const unstored: EditorChart = {
      ...chart,
      singers: chart.singers.map((singer) => ({
        ...singer,
        lines: singer.lines.map((line) => ({ ...line, switchStart: null })),
      })),
    };
    const placed = placeNotes(unstored, 10);
    // Line 10's last note ends at 2.1, line 11 starts at 3.
    expect(moveLimits(placed, new Set([102])).max).toBeCloseTo(0.9);
    expect(moveLimits(placed, new Set([103])).min).toBeCloseTo(-0.9);
  });

  it("splits a note on the grid: the second part holds the syllable", () => {
    const doc = setup();
    let second: number | null = null;
    doc.edit("Split", (tx) => (second = splitNote(tx, chart, 101, 1.62)));
    flush();
    expect(find(doc.chart(), 101)).toMatchObject({ start: 1.5, duration: expect.closeTo(0.1, 9), lyric: "wa" });
    expect(find(doc.chart(), second!)).toMatchObject({
      start: expect.closeTo(1.6, 9),
      duration: expect.closeTo(0.2, 9),
      lyric: "~",
      pitch: 64,
    });
  });

  it("doesn't split closer than a step to an end", () => {
    expect(canSplit(chart, { start: 1.5, duration: 0.3 }, 1.52)).toBe(false);
    expect(canSplit(chart, { start: 1.5, duration: 0.3 }, 1.55)).toBe(true);
    expect(canSplit(chart, { start: 1.5, duration: 0.3 }, 1.79)).toBe(false);
    const doc = setup();
    expect(doc.edit("Split", (tx) => void splitNote(tx, chart, 101, 1.52))).toBe(false);
  });
});
