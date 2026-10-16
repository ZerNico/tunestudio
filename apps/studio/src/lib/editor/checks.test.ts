import { describe, expect, it } from "vitest";

import type { EditorChart, EditorLine } from "~/lib/native/types";

import { chartProblems } from "./checks";
import { testNote, testSong } from "./test-chart";

const line = (id: number, notes: EditorLine["notes"], switchStart: number | null = null): EditorLine => ({
  id,
  switchStart,
  switchEnd: null,
  notes,
});

/** One singer at 300 BPM (a step is 50 ms) from GAP 0. */
function chart(lines: EditorLine[], song: Partial<EditorChart["song"]> = {}): EditorChart {
  return { bpm: 300, gap: 0, song: { ...testSong, ...song }, singers: [{ id: 1, index: 1, name: null, lines }] };
}

const summary = (problems: ReturnType<typeof chartProblems>) =>
  problems.map((problem) => [problem.message, problem.noteIds, problem.start]);

describe("chartProblems", () => {
  it("finds nothing in a clean chart", () => {
    expect(chartProblems(chart([line(1, [testNote(1, 1), testNote(2, 1.5)])]), 10)).toEqual([]);
  });

  it("lists overlapping notes as one problem per run, and each empty syllable", () => {
    const problems = chartProblems(
      chart([line(1, [testNote(1, 1), testNote(2, 1.2), testNote(3, 1.4), testNote(4, 3, " ")])]),
      10,
    );
    expect(summary(problems)).toEqual([
      ["Notes overlap", [1, 2, 3], 1],
      ["Empty syllable", [4], 3],
    ]);
  });

  it("keeps held syllables (~) out of it", () => {
    expect(chartProblems(chart([line(1, [testNote(1, 1), testNote(2, 1.5, "~")])]), 10)).toEqual([]);
  });

  it("finds notes past the song's end and outside the start and end marks", () => {
    const notes = [testNote(1, 0.5), testNote(2, 2), testNote(3, 8.9), testNote(4, 9.5)];
    expect(summary(chartProblems(chart([line(1, notes)], { start: 1, end: 8 }), 9.6))).toEqual([
      ["Notes before the start mark", [1], 0.5],
      ["Notes after the end mark", [3, 4], 8.9],
      ["Notes after the song's end", [4], 9.5],
    ]);
    // An unknown length checks nothing against it.
    expect(chartProblems(chart([line(1, notes)]), 0)).toEqual([]);
  });

  it("finds a stored line break inside a note", () => {
    const lines = [line(1, [testNote(1, 1, "la", 1)], 1.5), line(2, [testNote(2, 3)])];
    expect(chartProblems(chart(lines), 10)).toEqual([
      { key: "break:1", message: "Line break inside a note", noteIds: [], lineId: 1, start: 1.5, end: 1.5 },
    ]);
  });
});
