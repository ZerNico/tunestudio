import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import type { EditorChart, NoteType } from "~/lib/native/types";

import { createChartDocument } from "./document";
import {
  deleteNotes,
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
});
