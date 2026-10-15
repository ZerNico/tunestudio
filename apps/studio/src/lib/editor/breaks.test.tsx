import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import type { EditorChart } from "~/lib/native/types";

import { addBreak, breakLanding, breakRange, moveBreak, nearestGap, removeBreak } from "./breaks";
import { createChartDocument } from "./document";

const note = (id: number, start: number, lyric: string) => ({
  id,
  start,
  duration: 0.3,
  pitch: 64,
  lyric,
  type: "normal" as const,
  edited: false,
});

/** Grid: 0.05 s steps from 1 s. Line 10 ends at 2.1 s, its break is stored at 2.5 s; line 11 starts at 3 s. */
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
        { id: 11, switchStart: null, switchEnd: null, notes: [note(103, 3, "on "), note(104, 3.5, "and")] },
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
    const run = (build: Parameters<typeof doc.edit>[1]) => {
      const changed = doc.edit("Break", build);
      flush();
      return changed;
    };
    /** Each line's notes (ids) and switch. */
    const lines = () =>
      doc
        .chart()
        .singers[0]!.lines.map((line) => ({ notes: line.notes.map((item) => item.id), switch: line.switchStart }));
    return { doc, run, lines };
  });
}

describe("line breaks", () => {
  it("can go from a step after a line's first note to the next line's last note", () => {
    expect(breakRange(chart, 10)).toEqual({ min: expect.closeTo(1.05), max: 3.5 });
    expect(breakRange(chart, 11)).toBeNull();
  });

  it("retimes the switch within the gap, storing it", () => {
    const { run, lines } = setup();
    run((tx) => void moveBreak(tx, chart, 10, 2.71));
    expect(lines()).toEqual([
      { notes: [100, 101, 102], switch: expect.closeTo(2.7, 9) },
      { notes: [103, 104], switch: null },
    ]);
  });

  it("moves notes it is dragged across to the other line, and not into a note", () => {
    const { run, lines, doc } = setup();
    // 1.7 s is inside "wa" (1.5–1.8): "~lk" goes to the next line, the switch to the end of "wa".
    run((tx) => void moveBreak(tx, chart, 10, 1.7));
    expect(lines()).toEqual([
      { notes: [100, 101], switch: expect.closeTo(1.8, 9) },
      { notes: [102, 103, 104], switch: null },
    ]);
    // Moving notes to another line isn't changing them.
    expect(
      doc
        .chart()
        .singers[0]!.lines.flatMap((line) => line.notes)
        .every((item) => !item.edited),
    ).toBe(true);
  });

  it("only goes where it may: over a note, to its nearer edge", () => {
    // "wa" is 1.5–1.8: 1.55 is nearer its start (it goes to the next line), 1.75 nearer its end (it stays).
    expect(breakLanding(chart, 10, 1.56)).toBeCloseTo(1.5);
    expect(breakLanding(chart, 10, 1.74)).toBeCloseTo(1.8);
    // In a gap it stays where it is put (on the grid).
    expect(breakLanding(chart, 10, 2.62)).toBeCloseTo(2.6);
    // The first note can't leave its line: over it, only its end is allowed.
    expect(breakLanding(chart, 10, 1.02)).toBeCloseTo(1.3);
  });

  it("can't pass its neighbours: each line keeps a note", () => {
    const { run, lines } = setup();
    run((tx) => void moveBreak(tx, chart, 10, 9));
    expect(lines()).toEqual([
      { notes: [100, 101, 102, 103], switch: expect.closeTo(3.5, 9) },
      { notes: [104], switch: null },
    ]);
  });

  it("adds a break that splits a line, at a note's end when it falls inside one", () => {
    const { run, lines } = setup();
    expect(run((tx) => void addBreak(tx, chart, 1, 1.62))).toBe(true);
    expect(lines()).toEqual([
      { notes: [100, 101], switch: expect.closeTo(1.8, 9) },
      { notes: [102], switch: 2.5 },
      { notes: [103, 104], switch: null },
    ]);
  });

  it("adds no break that would leave a line without notes", () => {
    const { run } = setup();
    let added = true;
    run((tx) => void (added = addBreak(tx, chart, 1, 1)));
    expect(added).toBe(false);
  });

  it("removes a break, joining the lines", () => {
    const { run, lines } = setup();
    run((tx) => void removeBreak(tx, chart, 10));
    expect(lines()).toEqual([{ notes: [100, 101, 102, 103, 104], switch: null }]);
  });

  it("finds the gap nearest to a time for a new break, at its default switch", () => {
    expect(nearestGap(chart, 1, 1.4)).toBeCloseTo(1.3);
    expect(nearestGap(chart, 1, 3.1)).toBeCloseTo(3.3);
    expect(nearestGap(chart, 2, 1)).toBeNull();
  });

  it("keeps breaks out of overlapping notes: their whole stretch counts", () => {
    // A 1–4, B 2–6 (overlapping A), C 5–5.5 (inside B), D 7–7.5.
    const overlapping: EditorChart = {
      ...chart,
      singers: [
        {
          id: 1,
          index: 1,
          name: null,
          lines: [
            {
              id: 10,
              switchStart: null,
              switchEnd: null,
              notes: [
                { ...note(100, 1, "A"), duration: 3 },
                { ...note(101, 2, "B"), duration: 4 },
                { ...note(102, 5, "C"), duration: 0.5 },
                { ...note(103, 7, "D"), duration: 0.5 },
              ],
            },
          ],
        },
      ],
    };
    const root = createRoot(() => {
      const [selection, setSelection] = createSignal<number[]>([]);
      return createChartDocument<number[]>({
        chart: overlapping,
        save: async () => {},
        onFailed: () => {},
        selection,
        setSelection,
      });
    });
    // At 3 s, inside A and B: after the whole stretch (6 s), so C stays in the first line.
    root.edit("Add", (tx) => void addBreak(tx, overlapping, 1, 3));
    flush();
    const lines = root.chart().singers[0]!.lines;
    expect(lines.map((line) => line.notes.map((item) => item.id))).toEqual([[100, 101, 102], [103]]);
    expect(lines[0]!.switchStart).toBeCloseTo(6, 9);
  });
});
