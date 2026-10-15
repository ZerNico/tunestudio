import { describe, expect, it } from "vitest";

import type { DrawnNote } from "./chart";
import { adjacentNote, notesInBox, rangeSelection, toggled } from "./selection";

const note = (id: number, start: number, singer = 1, pitch = 60): DrawnNote => ({
  id,
  start,
  duration: 0.5,
  pitch,
  lyric: "la",
  type: "normal",
  edited: false,
  singer,
  lineId: 1,
});

// Singer 2's note 5 sits between singer 1's.
const notes = [note(1, 0), note(2, 1, 1, 62), note(5, 1.5, 2), note(3, 2, 1, 64), note(4, 3)];

describe("selection", () => {
  it("selects a range of the clicked singer's notes, either way round", () => {
    expect(rangeSelection(notes, 1, 3)).toEqual([1, 2, 3]);
    expect(rangeSelection(notes, 3, 1)).toEqual([1, 2, 3]);
    expect(rangeSelection(notes, 1, 5)).toEqual([5]);
  });

  it("toggles a note in and out", () => {
    expect(toggled([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggled([1, 2], 1)).toEqual([2]);
  });

  it("selects what a box touches in time and pitch", () => {
    expect(notesInBox(notes, { from: 0.8, to: 2.1, low: 61, high: 64 })).toEqual([2, 3]);
    expect(notesInBox(notes, { from: 0.5, to: 1, low: 0, high: 127 })).toEqual([]);
  });

  it("steps to the next or previous note of the same singer, or from the playhead", () => {
    expect(adjacentNote(notes, [2], 1, 0)?.id).toBe(3);
    expect(adjacentNote(notes, [2, 3], -1, 0)?.id).toBe(1);
    expect(adjacentNote(notes, [4], 1, 0)).toBeUndefined();
    expect(adjacentNote(notes, [], 1, 1.2)?.id).toBe(5);
    expect(adjacentNote(notes, [], -1, 1.2)?.id).toBe(2);
  });
});
