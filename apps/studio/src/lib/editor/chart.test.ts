import { describe, expect, it } from "vitest";

import type { EditorChart, EditorNote } from "~/lib/native/types";

import { chartEnd, defaultSwitch, drawnNotes, lineBreaks, lineIndexAt, lineSpans, lineText, stepLine } from "./chart";

let nextId = 1;
const note = (start: number, lyric: string, duration = 0.3): EditorNote => ({
  id: nextId++,
  start,
  duration,
  pitch: 64,
  lyric,
  type: "normal",
  edited: false,
});

const chart: EditorChart = {
  bpm: 300,
  gap: 1,
  singers: [
    {
      id: 1,
      index: 1,
      name: null,
      lines: [
        { id: 10, switchStart: null, switchEnd: null, notes: [note(1, "We "), note(1.4, "walk~ "), note(1.8, "on")] },
        { id: 11, switchStart: null, switchEnd: null, notes: [note(5, "to "), note(5.5, "the "), note(6, "sea")] },
      ],
    },
    {
      id: 2,
      index: 2,
      name: null,
      lines: [{ id: 20, switchStart: null, switchEnd: null, notes: [note(3, "Hel"), note(3.3, "lo", 1)] }],
    },
  ],
};

describe("editor chart", () => {
  it("flattens every singer's notes into time order", () => {
    const notes = drawnNotes(chart);
    expect(notes.map((n) => n.lyric)).toEqual(["We ", "walk~ ", "on", "Hel", "lo", "to ", "the ", "sea"]);
    expect(notes[3]).toMatchObject({ singer: 2, lineId: 20 });
    expect(chartEnd(notes)).toBeCloseTo(6.3);
  });

  it("gives each line its span and readable text", () => {
    expect(lineText(chart.singers[0]!.lines[0]!.notes)).toBe("We walk on");
    const spans = lineSpans(chart);
    expect(spans.map((span) => [span.text, span.singer])).toEqual([
      ["We walk on", 1],
      ["Hello", 2],
      ["to the sea", 1],
    ]);
    expect(spans[1]!.duration).toBeCloseTo(1.3);
  });

  it("steps to the next line, and back to the current line's start first", () => {
    const spans = lineSpans(chart);
    expect(lineIndexAt(spans, 4)).toBe(1);
    expect(stepLine(spans, 1, 1)?.text).toBe("Hello");
    expect(stepLine(spans, 5.8, -1)?.text).toBe("to the sea");
    expect(stepLine(spans, 5, -1)?.text).toBe("Hello");
    expect(stepLine(spans, 7, 1)).toBeUndefined();
  });
});

describe("line breaks", () => {
  it("puts each break at the stored switch, or by default right after the line (later in a long gap)", () => {
    expect(defaultSwitch(2, 3)).toBe(2);
    expect(defaultSwitch(2, 5)).toBe(3);
    // P1: 1.0–2.1, then 5.0–6.3 (a gap of 2.9 s, nothing stored); P2 has one line, so no break.
    const breaks = lineBreaks(chart);
    expect(breaks).toEqual([
      { lineId: 10, singer: 1, time: expect.closeTo(3.1), auto: true, gapStart: expect.closeTo(2.1), gapEnd: 5 },
    ]);
    const storing = (switchStart: number): EditorChart => ({
      ...chart,
      singers: chart.singers.map((singer, s) => ({
        ...singer,
        lines: singer.lines.map((line, l) => (s === 0 && l === 0 ? { ...line, switchStart } : line)),
      })),
    });
    expect(lineBreaks(storing(4))[0]).toMatchObject({ time: 4, auto: false });
    // A stored switch outside the gap is drawn at its edge.
    expect(lineBreaks(storing(9))[0]!.time).toBe(5);
  });
});
