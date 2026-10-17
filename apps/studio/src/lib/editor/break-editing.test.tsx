import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type { EditorChart } from "~/lib/native/types";

import { createBreakEditing } from "./break-editing";
import { lineBreaks } from "./chart";
import { createChartDocument } from "./document";
import { breaksOnly, notesOnly, type Selection } from "./selection";
import { testNote as note, testSong } from "./test-chart";

/** Grid: 0.05 s steps from 1 s. Line 10's break is stored at 2.5 s. */
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
        { id: 10, switchStart: 2.5, switchEnd: null, notes: [note(100, 1), note(101, 1.5), note(102, 1.8)] },
        { id: 11, switchStart: null, switchEnd: null, notes: [note(103, 3), note(104, 3.5)] },
      ],
    },
  ],
};

function setup(playhead = 0) {
  return createRoot(() => {
    const [selection, setSelection] = createSignal<Selection>(notesOnly([5]));
    const doc = createChartDocument<Selection>({
      chart,
      save: async () => {},
      onFailed: () => {},
      selection,
      setSelection,
    });
    const pointer = new EventTarget();
    const onRefused = vi.fn();
    const editing = createBreakEditing({
      doc: () => doc,
      selection,
      setSelection,
      singer: () => 1,
      playheadTime: () => playhead,
      onRefused,
      pointerTarget: pointer,
    });
    const marker = () => lineBreaks(doc.chart()).find((item) => item.lineId === 10)!;
    /** Presses the break after line 10 and drags it `dx` px (100 px a second). */
    const drag = (moves: number[], release = true) => {
      editing.follow(marker(), { clientX: 0 }, 100);
      for (const clientX of moves) pointer.dispatchEvent(Object.assign(new Event("pointermove"), { clientX }));
      flush();
      if (release) {
        pointer.dispatchEvent(new Event("pointerup"));
        flush();
      }
    };
    const press = (key: string) => {
      const handled = editing.key({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false });
      flush();
      return handled;
    };
    const lines = () => doc.chart().singers[0]!.lines.map((line) => line.notes.map((item) => item.id));
    return { doc, editing, drag, press, lines, marker, selection, setSelection, onRefused };
  });
}

describe("break editing", () => {
  it("previews a dragged break with how many notes it moves, and writes it when let go", () => {
    const { drag, editing, lines, doc } = setup();
    // 2.5 s - 0.8 s = 1.7 s: "1.8" moves to the next line.
    drag([-80], false);
    // 1.7 s is inside "1.5" (to 1.8): the nearest allowed spot is its end, where the note at 1.8 moves on.
    expect(editing.drag()).toEqual({ lineId: 10, time: expect.closeTo(1.8, 9), label: "0:01.8 · 1 note moves" });
    expect(lines()).toEqual([
      [100, 101, 102],
      [103, 104],
    ]);
    drag([-80]);
    expect(lines()).toEqual([
      [100, 101],
      [102, 103, 104],
    ]);
    expect(doc.undoLabel()).toBe("Move line break");
  });

  it("puts a dragged break back on Esc", () => {
    const { drag, press, editing, doc } = setup();
    drag([-80], false);
    expect(press("Escape")).toBe(true);
    expect(editing.drag()).toBeNull();
    expect(doc.undoLabel()).toBeNull();
  });

  it("removes a double-clicked break, and it from the selection", () => {
    const { editing, marker, lines, selection, setSelection } = setup();
    setSelection(breaksOnly([10]));
    editing.breakDoubleClick(marker());
    flush();
    expect(lines()).toHaveLength(1);
    expect(selection()).toEqual({ notes: [], breaks: [] });
  });

  it("adds a break where the lane is double-clicked, or in the gap nearest the playhead with B", () => {
    const { editing, lines } = setup();
    editing.laneDoubleClick(1.4);
    flush();
    expect(lines()).toEqual([[100], [101, 102], [103, 104]]);
    const atPlayhead = setup(3.1);
    expect(atPlayhead.press("b")).toBe(true);
    expect(atPlayhead.lines()).toEqual([[100, 101, 102], [103], [104]]);
  });

  it("keeps the selected break the one picked when a break is added or removed next to it", () => {
    const { editing, setSelection, selection, doc } = setup();
    const lineOf = (note: number) =>
      doc.chart().singers[0]!.lines.find((line) => line.notes.some((item) => item.id === note))!.id;
    // The break at 2.5 s is selected; one added at 1.4 s splits its line, and 2.5 s now ends the new line.
    setSelection(breaksOnly([10]));
    editing.laneDoubleClick(1.4);
    flush();
    expect(lineOf(101)).not.toBe(10);
    expect(selection().breaks).toEqual([lineOf(101)]);
    // Removing the new break joins the lines again: 2.5 s ends line 10 once more.
    editing.breakDoubleClick(lineBreaks(doc.chart()).find((item) => item.lineId === 10)!);
    flush();
    expect(selection().breaks).toEqual([10]);
    expect(lineBreaks(doc.chart())).toMatchObject([{ lineId: 10, time: 2.5 }]);
  });

  it("says so when a break can't go there", () => {
    const { editing, onRefused, lines } = setup();
    editing.laneDoubleClick(0.5);
    flush();
    expect(onRefused).toHaveBeenCalledWith("Put the line break between two notes of a line.");
    expect(lines()).toHaveLength(2);
  });

  it("adds a break with a double-click for whichever shown singer has a line there, the active one first", () => {
    const duet: EditorChart = {
      ...chart,
      singers: [
        ...chart.singers,
        {
          id: 2,
          index: 2,
          name: null,
          lines: [{ id: 20, switchStart: null, switchEnd: null, notes: [note(200, 5), note(201, 6)] }],
        },
      ],
    };
    const onSinger = vi.fn();
    const { doc, editing } = createRoot(() => {
      const [selection, setSelection] = createSignal<Selection>(notesOnly([]));
      const doc = createChartDocument<Selection>({
        chart: duet,
        save: async () => {},
        onFailed: () => {},
        selection,
        setSelection,
      });
      const editing = createBreakEditing({
        doc: () => doc,
        selection,
        setSelection,
        singer: () => 1,
        singers: () => [1, 2],
        onSinger,
        playheadTime: () => 0,
        onRefused: () => {},
      });
      return { doc, editing };
    });
    // P1 is active, but only P2 sings at 5.5 s.
    editing.laneDoubleClick(5.5);
    flush();
    expect(doc.chart().singers[1]!.lines.map((line) => line.notes.map((n) => n.id))).toEqual([[200], [201]]);
    expect(onSinger).toHaveBeenCalledWith(2);
    // Where P1 has a line, it gets the break and stays active.
    editing.laneDoubleClick(1.6);
    flush();
    expect(doc.chart().singers[0]!.lines).toHaveLength(3);
    expect(onSinger).toHaveBeenCalledOnce();
  });

  it("resets a stored break's timing to the default rule, undoably", () => {
    const { editing, doc } = setup();
    const stored = lineBreaks(doc.chart()).find((item) => item.lineId === 10)!;
    expect(stored.auto).toBe(false);
    editing.resetTiming(stored);
    flush();
    expect(lineBreaks(doc.chart()).find((item) => item.lineId === 10)!.auto).toBe(true);
    expect(doc.undoLabel()).toBe("Reset line break timing");
    // Already default: nothing to do.
    editing.resetTiming(lineBreaks(doc.chart()).find((item) => item.lineId === 10)!);
    expect(doc.undoLabel()).toBe("Reset line break timing");
    doc.undo();
    flush();
    expect(doc.chart().singers[0]!.lines[0]!.switchStart).toBe(2.5);
  });
});
