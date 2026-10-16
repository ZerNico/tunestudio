import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import type { ChartChange } from "~/lib/native/contract";
import type { EditorChart, RangeChart } from "~/lib/native/types";

import { rangeScope, replaceRange, validRangeChart } from "./chart-range";
import { createChartDocument } from "./document";
import { testNote, testSong } from "./test-chart";

const chart = () => ({
  bpm: 300,
  gap: 0.123,
  song: testSong,
  singers: [
    {
      id: 17,
      index: 1,
      name: null,
      lines: [
        {
          id: 10,
          switchStart: 4.123,
          switchEnd: 4.323,
          notes: [testNote(100, 1.123, "before "), testNote(101, 2.123, "old "), testNote(102, 3.123, "after")],
        },
        { id: 11, switchStart: 7.123, switchEnd: 7.223, notes: [testNote(103, 6.123, "later")] },
      ],
    },
    {
      id: 18,
      index: 2,
      name: "Other",
      lines: [{ id: 12, switchStart: null, switchEnd: null, notes: [testNote(104, 2.123, "untouched")] }],
    },
  ],
});
const range = { start: 2.123, end: 2.823 };
const result = (): RangeChart => ({
  bpm: 300,
  gap: 0.123,
  vocals: "sha",
  breaks: [2.473],
  lines: [
    { notes: [{ start: 2.123, duration: 0.25, pitch: 65, lyric: "new ", type: "normal" }] },
    { notes: [{ start: 2.523, duration: 0.25, pitch: 67, lyric: "words ", type: "normal" }] },
  ],
});

function setup(source = chart()) {
  return createRoot(() => {
    let selection = [101];
    const saved: ChartChange[][] = [];
    const doc = createChartDocument({
      chart: source,
      save: async (changes) => {
        saved.push(changes);
      },
      onFailed: () => {},
      selection: () => selection,
      setSelection: (value: number[]) => {
        selection = value;
      },
    });
    const apply = (output = result()) => {
      let ids: number[] = [];
      const applied = doc.edit(
        "Chart from lyrics",
        (tx) => {
          ids = replaceRange(tx, doc.chart(), 17, range, output);
        },
        { selectionAfter: () => ids },
      );
      flush();
      return applied;
    };
    return { doc, apply, saved, selection: () => selection };
  });
}

describe("range scope", () => {
  it("expands transitively to whole intersecting notes and grid boundaries for only one singer", () => {
    const source = chart();
    source.singers[0]!.lines[0]!.notes = [
      testNote(100, 1.12, "one ", 0.6),
      testNote(101, 1.6, "two ", 0.6),
      testNote(102, 2.1, "three", 0.4),
    ];
    const scope = rangeScope(source, 17, { start: 1.3, end: 1.5 })!;
    expect(scope.start).toBeCloseTo(1.073);
    expect(scope.end).toBeCloseTo(2.523);
    expect(scope.count).toBe(3);
    expect(scope.text).toBe("one two three");
  });
  it("ends at the audio's end rather than the next grid step, unless a note goes past it", () => {
    const source = chart();
    // 12.01 s is between grid steps (12.973 - 0.05k).
    expect(rangeScope(source, 17, { start: 1.3, end: 12.01 }, 12.01)!.end).toBe(12.01);
    expect(rangeScope(source, 17, { start: 1.3, end: 12.01 })!.end).toBeCloseTo(12.023);
    source.singers[0]!.lines[1]!.notes.push(testNote(105, 11.973, "end", 0.1));
    expect(rangeScope(source, 17, { start: 1.3, end: 12.01 }, 12.01)!.end).toBeCloseTo(12.073);
  });
  it("accepts an empty singer, rejects missing singers and invalid grids", () => {
    const source = chart();
    source.singers[0]!.lines = [];
    expect(rangeScope(source, 17, range)?.count).toBe(0);
    expect(rangeScope(source, 99, range)).toBeNull();
    expect(rangeScope({ ...source, bpm: 0 }, 17, range)).toBeNull();
  });
});

describe("range replacement", () => {
  it("splits prefix and suffix, retains outside fields and trailing switches, isolates the duet and undoes exactly", async () => {
    const source = chart();
    const { doc, apply, saved, selection } = setup(source);
    expect(apply()).toBe(true);
    const after: EditorChart = JSON.parse(JSON.stringify(doc.chart()));
    const lines = after.singers[0]!.lines;
    expect(lines.map((line) => line.notes.map((note) => note.lyric))).toEqual([
      ["before "],
      ["new "],
      ["words "],
      ["after"],
      ["later"],
    ]);
    expect(lines[0]).toMatchObject({ id: 10, switchStart: 2.123, switchEnd: 2.123 });
    expect(lines[3]).toMatchObject({ switchStart: 4.123, switchEnd: 4.323 });
    expect(lines[3]!.notes).toEqual([source.singers[0]!.lines[0]!.notes[2]]);
    expect(lines[4]).toEqual(source.singers[0]!.lines[1]);
    expect(after.singers[1]).toEqual(source.singers[1]);
    expect(selection()).toEqual(lines.slice(1, 3).flatMap((line) => line.notes.map((note) => note.id)));
    expect(lines[1]!.notes[0]!.edited).toBe(true);
    const selected = [...selection()];
    await doc.saved();
    expect(saved).toHaveLength(1);
    doc.undo();
    flush();
    expect(doc.chart()).toEqual(source);
    expect(selection()).toEqual([101]);
    doc.redo();
    flush();
    expect(doc.chart()).toEqual(after);
    expect(selection()).toEqual(selected);
  });

  it("inserts into a gap within one line and into an empty singer", () => {
    for (const empty of [false, true]) {
      const source = chart();
      if (empty) source.singers[0]!.lines = [];
      else source.singers[0]!.lines[0]!.notes.splice(1, 1);
      const { apply, doc } = setup(source);
      expect(apply()).toBe(true);
      expect(
        doc.chart().singers[0]!.lines.filter((line) => line.notes.some((note) => note.lyric === "new ")),
      ).toHaveLength(1);
    }
  });

  it.each([
    {
      name: "a line's tail",
      notes: (all: EditorChart["singers"][number]["lines"][number]["notes"]) => all.slice(0, 2),
    },
    { name: "a whole line", notes: (all: EditorChart["singers"][number]["lines"][number]["notes"]) => all.slice(1, 2) },
    {
      name: "a gap after a line",
      notes: (all: EditorChart["singers"][number]["lines"][number]["notes"]) => all.slice(0, 1),
    },
  ])("keeps the break to the next line after replacing $name", ({ notes }) => {
    const source = chart();
    const line = source.singers[0]!.lines[0]!;
    line.notes = notes(line.notes);
    const { apply, doc } = setup(source);
    expect(apply()).toBe(true);
    const lines = doc.chart().singers[0]!.lines;
    const generated = lines.find((item) => item.notes.some((note) => note.lyric === "words "));
    expect(generated).toMatchObject({ switchStart: 4.123, switchEnd: 4.323 });
    // A surviving start of the line gets the default break before the generated lines.
    const prefix = lines.find((item) => item.id === 10);
    if (prefix) expect(prefix).toMatchObject({ switchStart: null, switchEnd: null });
    expect(lines.at(-1)).toEqual(source.singers[0]!.lines[1]);
    doc.undo();
    flush();
    expect(doc.chart()).toEqual(source);
  });

  it("replaces a whole final line and removes only its emptied row", () => {
    const source = chart();
    source.singers[0]!.lines = [{ id: 10, switchStart: null, switchEnd: null, notes: [testNote(101, 2.123)] }];
    const { apply, doc } = setup(source);
    expect(apply()).toBe(true);
    expect(doc.chart().singers[0]!.lines.map((line) => line.id)).not.toContain(10);
    doc.undo();
    flush();
    expect(doc.chart()).toEqual(source);
  });

  it("rejects empty, malformed, out-of-range and overlapping output without touching history", () => {
    const bad = [
      { ...result(), lines: [], breaks: [] },
      { ...result(), bpm: 301 },
      { ...result(), lines: [{ notes: [] }, ...result().lines.slice(1)] },
      { ...result(), lines: [result().lines[0]!, { notes: [] }] },
      { ...result(), breaks: [NaN] },
    ];
    for (const change of [{ start: 1 }, { duration: 10 }, { pitch: NaN }, { duration: 0 }, { start: 2.124 }]) {
      const item = result();
      Object.assign(item.lines[0]!.notes[0]!, change);
      bad.push(item);
    }
    for (const item of bad) {
      const { apply, doc } = setup();
      expect(validRangeChart(chart(), range, item)).toBe(false);
      expect(apply(item)).toBe(false);
      expect(doc.chart()).toEqual(chart());
      expect(doc.undoLabel()).toBeNull();
    }
  });

  it("refuses to delete a note crossing the unexpanded boundary", () => {
    const source = chart();
    source.singers[0]!.lines[0]!.notes[1] = { ...source.singers[0]!.lines[0]!.notes[1]!, duration: 1 };
    const { apply, doc } = setup(source);
    expect(apply()).toBe(false);
    expect(doc.chart()).toEqual(source);
  });
});
