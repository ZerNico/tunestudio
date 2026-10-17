import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import type { EditorChart } from "~/lib/native/types";

import { gridStep, onGrid } from "./chart";
import { createChartDocument } from "./document";
import {
  addNote,
  canSplit,
  changeGap,
  defaultLength,
  deleteSelection,
  lineAt,
  splitNote,
  fits,
  lengthLimits,
  mergeNotes,
  moveNotes,
  moveSelection,
  overlapping,
  pitchFits,
  pitchLimits,
  placeNotes,
  planMove,
  resizeNotes,
  resizeStarts,
  snapDelta,
  startLimits,
  shiftPitch,
  toggleFlag,
} from "./edits";
import { testNote as note, testSong } from "./test-chart";

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

function setup(start: EditorChart = chart) {
  return createRoot(() => {
    const [selection, setSelection] = createSignal<number[]>([]);
    const doc = createChartDocument<number[]>({
      chart: start,
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

describe("limits with a stored break inside a note", () => {
  it("still lets the note shrink, never forcing a move", () => {
    // Line 10's break is stored at 2.5 s; a note there from 2.4 s to 2.9 s already reaches past it.
    const inside: EditorChart = {
      ...chart,
      singers: [
        {
          ...chart.singers[0]!,
          lines: [
            { ...chart.singers[0]!.lines[0]!, notes: [note(100, 1, "We "), note(105, 2.4, "on", 0.5)] },
            chart.singers[0]!.lines[1]!,
          ],
        },
      ],
    };
    const placed = placeNotes(inside, 10);
    const limits = lengthLimits(placed, new Set([105]), 0.05);
    expect(limits.max).toBe(0);
    expect(limits.min).toBeLessThan(0);
  });
});

describe("the gap", () => {
  it("moves every note, stored break and the medley with it, not the song's start, end or preview", () => {
    const doc = setup();
    doc.edit("Song", (tx) => tx.updateSong({ start: 0.5, previewStart: 4, medleyStart: 1, medleyEnd: 3.3 }));
    flush();
    const before = doc.chart();
    expect(doc.tryEdit("Change gap", (tx) => changeGap(tx, before, 1.12))).toBeNull();
    flush();
    const after = doc.chart();
    expect(after.gap).toBeCloseTo(1.12, 9);
    expect(notesOf(after).map((item) => item.start)).toEqual(
      [1.12, 1.62, 1.92, 3.12].map((value) => expect.closeTo(value, 9)),
    );
    expect(after.singers[0]!.lines.map((line) => line.switchStart)).toEqual([expect.closeTo(2.62, 9), null]);
    expect(after.song).toMatchObject({ start: 0.5, previewStart: 4, medleyStart: expect.closeTo(1.12, 9) });
    expect(after.song.medleyEnd).toBeCloseTo(3.42, 9);
    // Still on the grid, which moved too.
    expect(onGrid(after, after.singers[0]!.lines[0]!.notes[1]!.start)).toBeCloseTo(1.62, 9);
    doc.undo();
    flush();
    expect(doc.chart().gap).toBe(1);
    expect(find(doc.chart(), 100)!.start).toBe(1);
  });

  it("is refused where notes would leave the song, and keeps whether notes were edited", () => {
    const doc = setup();
    expect(doc.tryEdit("Change gap", (tx) => changeGap(tx, chart, -0.5))).toBe("Notes would start before the song.");
    expect(doc.tryEdit("Change gap", (tx) => changeGap(tx, chart, 2, 3.5))).toBe(
      "Notes would go past the end of the song.",
    );
    expect(doc.undoLabel()).toBeNull();
    doc.tryEdit("Change gap", (tx) => changeGap(tx, chart, 1.1, 10));
    flush();
    expect(notesOf(doc.chart()).every((item) => !item.edited)).toBe(true);
  });
});

describe("grid", () => {
  it("steps 15 / BPM seconds from the gap", () => {
    expect(gridStep(chart)).toBeCloseTo(0.05);
    expect(onGrid(chart, 1.123)).toBeCloseTo(1.1);
  });
});

describe("limits", () => {
  const placed = placeNotes(chart, 10);

  it("lets notes move up to a stored break and the song's start, through other notes", () => {
    expect(planMove(chart, 10, new Set([101])).limits).toEqual({ min: -1.5, max: expect.closeTo(0.7) });
    expect(planMove(chart, 10, new Set([103])).limits).toEqual({ min: -0.5, max: expect.closeTo(6.7) });
  });

  it("takes selected line breaks along: they stay out of the notes that don't move", () => {
    // Line 10's notes that stay end at 2.1, the break is at 2.5.
    expect(planMove(chart, 10, new Set([103]), new Set([10])).limits).toEqual({
      min: expect.closeTo(-0.4),
      max: expect.closeTo(6.7),
    });
    // The break alone: between line 10's end and line 11's start.
    expect(planMove(chart, 10, new Set(), new Set([10])).limits).toEqual({
      min: expect.closeTo(-0.4),
      max: expect.closeTo(0.5),
    });
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
    doc.edit("Delete", (tx) => deleteSelection(tx, chart, new Set([101, 103])));
    flush();
    expect(doc.chart().singers[0]!.lines.map((line) => line.notes.map((item) => item.id))).toEqual([[100, 102]]);
  });

  it("deletes line breaks with notes: the lines either side are one, or go when no note is left", () => {
    const doc = setup();
    doc.edit("Delete", (tx) => deleteSelection(tx, chart, new Set([101]), new Set([10])));
    flush();
    expect(doc.chart().singers[0]!.lines.map((line) => line.notes.map((item) => item.id))).toEqual([[100, 102, 103]]);
    // It ends where the later line did: no switch stored.
    expect(doc.chart().singers[0]!.lines[0]!.switchStart).toBeNull();
    const all = setup();
    all.edit("Delete", (tx) => deleteSelection(tx, chart, new Set([100, 101, 102, 103]), new Set([10])));
    flush();
    expect(all.chart().singers[0]!.lines).toEqual([]);
  });

  it("joins three lines when the two breaks between them are deleted, and undoes it", () => {
    const three: EditorChart = {
      ...chart,
      singers: [
        {
          ...chart.singers[0]!,
          lines: [
            { id: 10, switchStart: 1.4, switchEnd: null, notes: [note(100, 1)] },
            { id: 11, switchStart: 2.4, switchEnd: null, notes: [note(101, 2)] },
            { id: 12, switchStart: 3.4, switchEnd: null, notes: [note(102, 3)] },
            { id: 13, switchStart: null, switchEnd: null, notes: [note(103, 4)] },
          ],
        },
      ],
    };
    const doc = createRoot(() => {
      const [selection, setSelection] = createSignal<number[]>([]);
      return createChartDocument<number[]>({
        chart: three,
        save: async () => {},
        onFailed: () => {},
        selection,
        setSelection,
      });
    });
    const lines = () =>
      doc.chart().singers[0]!.lines.map((line) => ({ notes: line.notes.map((item) => item.id), at: line.switchStart }));
    const before = lines();
    doc.edit("Delete", (tx) => deleteSelection(tx, three, new Set([101]), new Set([10, 11])));
    flush();
    expect(lines()).toEqual([
      { notes: [100, 102], at: 3.4 },
      { notes: [103], at: null },
    ]);
    doc.undo();
    flush();
    expect(lines()).toEqual(before);
    doc.redo();
    flush();
    expect(lines()).toEqual([
      { notes: [100, 102], at: 3.4 },
      { notes: [103], at: null },
    ]);
  });

  it("limits each singer's notes by their own lines in a duet", () => {
    const duet: EditorChart = {
      ...chart,
      singers: [
        ...chart.singers,
        {
          id: 2,
          index: 2,
          name: null,
          lines: [{ id: 20, switchStart: null, switchEnd: null, notes: [note(200, 2.2)] }],
        },
      ],
    };
    // Singer 2's note at 2.2 s is no wall for singer 1's, nor the other way round.
    expect(planMove(duet, 10, new Set([101])).limits).toEqual({ min: -1.5, max: expect.closeTo(0.7) });
    expect(planMove(duet, 10, new Set([200])).limits).toEqual({ min: expect.closeTo(-2.2), max: expect.closeTo(7.5) });
  });

  it("moves selected line breaks with the notes, storing where they go", () => {
    const doc = setup();
    doc.edit("Move", (tx) => moveSelection(tx, chart, planMove(chart, 10, new Set([103]), new Set([10])), 0.2));
    flush();
    expect(find(doc.chart(), 103)!.start).toBeCloseTo(3.2);
    expect(doc.chart().singers[0]!.lines[0]!.switchStart).toBeCloseTo(2.7);
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
    // Line 10's last note ends at 2.1, line 11 starts at 3.
    expect(planMove(unstored, 10, new Set([102])).limits.max).toBeCloseTo(0.9);
    expect(planMove(unstored, 10, new Set([103])).limits.min).toBeCloseTo(-0.9);
    // Both lines moving: the gap goes with them, to the song's start and end.
    expect(planMove(unstored, 10, new Set([100, 101, 102, 103])).limits).toEqual({ min: -1, max: expect.closeTo(6.7) });
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

  it("gives the word's space to the held part, and won't split into the next line", () => {
    const doc = setup();
    let second: number | null = null;
    // "We " (1 s to 1.3 s) at 1.15 s.
    doc.edit("Split", (tx) => void (second = splitNote(tx, chart, 100, 1.15)));
    flush();
    expect(find(doc.chart(), 100)!.lyric).toBe("We");
    expect(find(doc.chart(), second!)!.lyric).toBe("~ ");
    // A note reaching past the next line's first note (3 s).
    const reaching: EditorChart = {
      ...chart,
      singers: [
        {
          ...chart.singers[0]!,
          lines: [
            { ...chart.singers[0]!.lines[0]!, switchStart: null, notes: [note(100, 1, "We ", 2.5)] },
            chart.singers[0]!.lines[1]!,
          ],
        },
      ],
    };
    const reachingDoc = setup(reaching);
    expect(reachingDoc.edit("Split", (tx) => void splitNote(tx, reaching, 100, 3.2))).toBe(false);
    expect(reachingDoc.edit("Split", (tx) => void splitNote(tx, reaching, 100, 2))).toBe(true);
  });
});
