import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type { EditorChart } from "~/lib/native/types";

import { createBreakEditing } from "./break-editing";
import { lineBreaks } from "./chart";
import { createChartDocument } from "./document";

const note = (id: number, start: number) => ({
  id,
  start,
  duration: 0.3,
  pitch: 64,
  lyric: "la",
  type: "normal" as const,
  edited: false,
});

/** Grid: 0.05 s steps from 1 s. Line 10's break is stored at 2.5 s. */
const chart: EditorChart = {
  bpm: 300,
  gap: 1,
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
    const [selection, setSelection] = createSignal<number[]>([5]);
    const doc = createChartDocument<number[]>({
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
      singer: () => 1,
      playheadTime: () => playhead,
      onSelect: () => setSelection([]),
      onRefused,
      pointerTarget: pointer,
    });
    const marker = () => lineBreaks(doc.chart()).find((item) => item.lineId === 10)!;
    /** Presses the break after line 10 and drags it `dx` px (100 px a second). */
    const drag = (moves: number[], release = true) => {
      editing.breakDown(marker(), { clientX: 0 }, 100);
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
    return { doc, editing, drag, press, lines, marker, selection, onRefused };
  });
}

describe("break editing", () => {
  it("selects a marker when pressed, which deselects the notes", () => {
    const { drag, editing, selection } = setup();
    drag([]);
    expect(editing.selected()).toBe(10);
    expect(selection()).toEqual([]);
  });

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

  it("removes a selected break with Delete, or one double-clicked", () => {
    const first = setup();
    first.drag([]);
    first.press("Delete");
    expect(first.lines()).toEqual([[100, 101, 102, 103, 104]]);
    expect(first.editing.selected()).toBeNull();
    const second = setup();
    second.editing.breakDoubleClick(second.marker());
    flush();
    expect(second.lines()).toHaveLength(1);
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

  it("says so when a break can't go there", () => {
    const { editing, onRefused, lines } = setup();
    editing.laneDoubleClick(0.5);
    flush();
    expect(onRefused).toHaveBeenCalledWith("Put the line break between two notes of a line.");
    expect(lines()).toHaveLength(2);
  });
});
