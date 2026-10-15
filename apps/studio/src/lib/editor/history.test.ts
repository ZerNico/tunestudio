import { describe, expect, it } from "vitest";

import type { ChartChange } from "~/lib/native/contract";

import { createHistory, invert, mergeChanges, type Transaction } from "./history";

const fields = (start: number, pitch = 64) => ({
  lineId: 1,
  start,
  duration: 0.3,
  pitch,
  lyric: "la",
  type: "normal" as const,
  edited: true,
});

const move = (id: number, from: number, to: number): ChartChange => ({
  table: "note",
  id,
  before: fields(from),
  after: fields(to),
});

const step = (label: string, changes: ChartChange[], at = 0, merge?: string): Transaction<number[]> => ({
  label,
  changes,
  selection: { before: [], after: [1] },
  merge,
  at,
});

describe("invert", () => {
  it("undoes backwards with before and after swapped", () => {
    const changes: ChartChange[] = [
      { table: "line", id: 9, before: null, after: { singerId: 1, switchStart: null, switchEnd: null } },
      move(1, 1, 2),
    ];
    expect(invert(changes)).toEqual([
      move(1, 2, 1),
      { table: "line", id: 9, before: { singerId: 1, switchStart: null, switchEnd: null }, after: null },
    ]);
  });
});

describe("mergeChanges", () => {
  it("keeps each row's first before and last after, and drops rows that end as they began", () => {
    expect(mergeChanges([move(1, 1, 2), move(2, 5, 6)], [move(1, 2, 3), move(2, 6, 5)])).toEqual([move(1, 1, 3)]);
  });

  it("merges song details field by field", () => {
    expect(
      mergeChanges(
        [{ table: "song", before: { bpm: 300 }, after: { bpm: 310 } }],
        [{ table: "song", before: { bpm: 310, gap: 1 }, after: { bpm: 320, gap: 2 } }],
      ),
    ).toEqual([{ table: "song", before: { bpm: 300, gap: 1 }, after: { bpm: 320, gap: 2 } }]);
  });
});

describe("history", () => {
  it("undoes and redoes in order, and a new step drops what could be redone", () => {
    const history = createHistory<number[]>();
    history.push(step("Move note", [move(1, 1, 2)]));
    history.push(step("Move note again", [move(1, 2, 3)]));
    expect(history.undoLabel()).toBe("Move note again");
    expect(history.undo()?.label).toBe("Move note again");
    expect(history.redoLabel()).toBe("Move note again");
    expect(history.undo()?.label).toBe("Move note");
    expect(history.undo()).toBeUndefined();
    expect(history.redo()?.label).toBe("Move note");
    history.push(step("Delete note", [{ table: "note", id: 1, before: fields(2), after: null }]));
    expect(history.redoLabel()).toBeNull();
  });

  it("merges steps with the same key close together into one", () => {
    const history = createHistory<number[]>();
    history.push(step("Nudge", [move(1, 1, 1.1)], 0, "nudge"));
    history.push(step("Nudge", [move(1, 1.1, 1.2)], 400, "nudge"));
    history.push(step("Nudge", [move(1, 1.2, 1.3)], 800, "nudge"));
    const undone = history.undo();
    expect(undone?.changes).toEqual([move(1, 1, 1.3)]);
    expect(history.undo()).toBeUndefined();

    // Too far apart, or nudged back to where it was: separate steps, or none.
    history.push(step("Nudge", [move(1, 1, 1.1)], 0, "nudge"));
    history.push(step("Nudge", [move(1, 1.1, 1.2)], 5000, "nudge"));
    expect(history.undo()?.changes).toEqual([move(1, 1.1, 1.2)]);
    history.clear();
    history.push(step("Nudge", [move(1, 1, 1.1)], 0, "nudge"));
    history.push(step("Nudge", [move(1, 1.1, 1)], 100, "nudge"));
    expect(history.undoLabel()).toBeNull();
  });

  it("keeps the newest steps up to its limit", () => {
    const history = createHistory<number[]>(2);
    for (const label of ["a", "b", "c"]) history.push(step(label, [move(1, 0, 1)]));
    expect(history.undo()?.label).toBe("c");
    expect(history.undo()?.label).toBe("b");
    expect(history.undo()).toBeUndefined();
  });
});
