import { createMemo, createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type { EditorChart } from "~/lib/native/types";

import { drawnNotes } from "./chart";
import { createChartDocument } from "./document";
import { createNoteEditing, type NotePart } from "./note-editing";

const note = (id: number, start: number, lyric: string) => ({
  id,
  start,
  duration: 0.3,
  pitch: 64,
  lyric,
  type: "normal" as const,
  edited: false,
});

/** Grid: 0.05 s steps from 1 s. */
const chart: EditorChart = {
  bpm: 300,
  gap: 1,
  singers: [
    {
      id: 1,
      index: 1,
      name: null,
      lines: [
        { id: 10, switchStart: null, switchEnd: null, notes: [note(100, 1, "We "), note(101, 1.5, "walk")] },
        { id: 11, switchStart: null, switchEnd: null, notes: [note(102, 3, "on")] },
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
    const notes = createMemo(() => drawnNotes(doc.chart()));
    const onReveal = vi.fn();
    const onRefused = vi.fn();
    const pointer = new EventTarget();
    const editing = createNoteEditing({
      pointerTarget: pointer,
      doc: () => doc,
      notes,
      selection,
      setSelection,
      length: () => 10,
      playheadTime: () => 0,
      onReveal,
      onRefused,
    });
    /** Presses a key; returns whether the editor took it. */
    const press = (key: string, modifiers: Partial<Record<"shiftKey" | "metaKey" | "ctrlKey", boolean>> = {}) => {
      const handled = editing.key({
        key,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        ...modifiers,
      });
      flush();
      return handled;
    };
    const click = (id: number, modifiers: Partial<Record<"shiftKey" | "metaKey" | "ctrlKey", boolean>> = {}) => {
      editing.noteDown(
        notes().find((item) => item.id === id)!,
        {
          clientX: 0,
          clientY: 0,
          shiftKey: false,
          metaKey: false,
          ctrlKey: false,
          ...modifiers,
        },
      );
      flush();
    };
    /** Presses `part` of a note at (0, 0) and drags through `moves` (px; 100 px a second, 10 px a semitone). */
    const drag = (id: number, part: NotePart, moves: [number, number, boolean?][], release = true) => {
      editing.noteDown(
        notes().find((item) => item.id === id)!,
        { clientX: 0, clientY: 0, shiftKey: false, metaKey: false, ctrlKey: false },
        part,
        { pxPerSecond: 100, rowHeight: 10 },
      );
      for (const [clientX, clientY, shiftKey = false] of moves) {
        pointer.dispatchEvent(Object.assign(new Event("pointermove"), { clientX, clientY, shiftKey }));
      }
      flush();
      if (release) {
        pointer.dispatchEvent(new Event("pointerup"));
        flush();
      }
    };
    const find = (id: number) => notes().find((item) => item.id === id);
    return { doc, editing, selection, press, click, drag, find, onReveal, onRefused };
  });
}

describe("note editing", () => {
  it("selects with clicks: one, a range with Shift, toggling with Cmd/Ctrl", () => {
    const { click, selection } = setup();
    click(100);
    expect(selection()).toEqual([100]);
    click(102, { shiftKey: true });
    expect(selection()).toEqual([100, 101, 102]);
    click(101, { metaKey: true });
    expect(selection()).toEqual([100, 102]);
  });

  it("leaves keys alone with nothing selected, except Tab and select all", () => {
    const { press, selection, onReveal } = setup();
    expect(press("ArrowUp")).toBe(false);
    expect(press("Escape")).toBe(false);
    expect(press("Tab")).toBe(true);
    expect(selection()).toEqual([100]);
    expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ id: 100 }));
    expect(press("a", { metaKey: true })).toBe(true);
    expect(selection()).toEqual([100, 101, 102]);
    expect(press("Escape")).toBe(true);
    expect(selection()).toEqual([]);
  });

  it("changes pitch, position and length with the arrows, holding one as one undo step", () => {
    const { click, press, find, doc } = setup();
    click(101);
    press("ArrowUp");
    press("ArrowUp");
    press("ArrowUp", { shiftKey: true });
    expect(find(101)!.pitch).toBe(78);
    expect(doc.undoLabel()).toBe("Change pitch of note");
    doc.undo();
    flush();
    expect(find(101)!.pitch).toBe(64);
    press("ArrowRight");
    press("ArrowRight", { shiftKey: true });
    expect(find(101)).toMatchObject({ start: expect.closeTo(1.55, 9), duration: expect.closeTo(0.35, 9) });
  });

  it("doesn't move notes past the song's start", () => {
    const { click, press, find, doc } = setup();
    click(100);
    // 1 s from the start: 20 steps back fit, the 21st doesn't.
    for (let i = 0; i < 21; i++) press("ArrowLeft");
    expect(find(100)!.start).toBeCloseTo(0, 9);
    expect(doc.undoLabel()).toBe("Move note");
  });

  it("deletes the selection and selects nothing", () => {
    const { click, press, find, selection } = setup();
    click(100);
    click(101, { shiftKey: true });
    press("Backspace");
    expect(find(100)).toBeUndefined();
    expect(find(101)).toBeUndefined();
    expect(selection()).toEqual([]);
  });

  it("merges neighbours into one note, and says why when it can't", () => {
    const { click, press, find, selection, onRefused } = setup();
    click(100);
    click(101, { shiftKey: true });
    press("m");
    expect(find(100)!.lyric).toBe("We walk");
    expect(selection()).toEqual([100]);
    click(102, { shiftKey: true });
    press("m");
    expect(onRefused).toHaveBeenCalledWith("Select notes next to each other in one line to merge them.");
  });

  it("toggles the note type with G, R and F", () => {
    const { click, press, find } = setup();
    click(102);
    press("g");
    expect(find(102)!.type).toBe("golden");
    press("r");
    expect(find(102)!.type).toBe("golden-rap");
    press("f");
    expect(find(102)!.type).toBe("freestyle");
  });

  it("previews a drag on whole steps and semitones, changing nothing until it is let go", () => {
    const { drag, find, editing } = setup();
    // 12 px is 0.12 s: 2 steps of 0.05 s; 21 px up is 2 semitones.
    drag(
      101,
      "body",
      [
        [6, -8],
        [12, -21],
      ],
      false,
    );
    expect(editing.drag()).toMatchObject({ time: expect.closeTo(0.1), pitch: 2, label: "+2 steps · F♯4" });
    expect(find(101)!.start).toBe(1.5);
    drag(101, "body", []);
    expect(find(101)!.start).toBe(1.5);
    expect(editing.drag()).toBeNull();
  });

  it("writes a drag when it is let go", () => {
    const { drag, find, doc } = setup();
    drag(101, "body", [[12, -21]]);
    expect(find(101)).toMatchObject({ start: expect.closeTo(1.6, 9), pitch: 66, edited: true });
    expect(doc.undoLabel()).toBe("Move note");
  });

  it("keeps a Shift-drag to the way it went first", () => {
    const { drag, find } = setup();
    drag(101, "body", [
      [30, -4, true],
      [30, -40, true],
    ]);
    expect(find(101)).toMatchObject({ start: expect.closeTo(1.8, 9), pitch: 64 });
  });

  it("moves a start or an end with the edges", () => {
    const { drag, find } = setup();
    drag(102, "end", [[10, 0]]);
    expect(find(102)!.duration).toBeCloseTo(0.4, 9);
    drag(102, "start", [[-10, 0]]);
    expect(find(102)).toMatchObject({ start: expect.closeTo(2.9, 9), duration: expect.closeTo(0.5, 9) });
  });

  it("stops a drag at the song's start", () => {
    const { drag, find } = setup();
    drag(100, "body", [[-500, 0]]);
    expect(find(100)!.start).toBeCloseTo(0, 9);
  });

  it("moves the whole selection from any of its notes, and a click without a drag selects just that one", () => {
    const { click, drag, find, selection } = setup();
    click(100);
    click(101, { shiftKey: true });
    drag(101, "body", [[10, 0]]);
    expect([find(100)!.start, find(101)!.start]).toEqual([expect.closeTo(1.1, 9), expect.closeTo(1.6, 9)]);
    expect(selection()).toEqual([100, 101]);
    drag(101, "body", []);
    expect(selection()).toEqual([101]);
  });

  it("puts the notes back on Esc", () => {
    const { drag, press, find, editing, doc } = setup();
    drag(101, "body", [[50, 0]], false);
    expect(press("Escape")).toBe(true);
    expect(editing.drag()).toBeNull();
    expect(find(101)!.start).toBe(1.5);
    expect(doc.undoLabel()).toBeNull();
  });
});
