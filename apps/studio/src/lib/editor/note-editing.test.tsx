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

function setup(playhead = 0, start: EditorChart = chart) {
  return createRoot(() => {
    const [selection, setSelection] = createSignal<number[]>([]);
    const doc = createChartDocument<number[]>({
      chart: start,
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
      playheadTime: () => playhead,
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
    /** Draw tool: a press at `time` / `pitch` and a drag of `dx` px (none: a click). */
    const draw = (time: number, pitch: number, dx?: number) => {
      editing.drawDown(
        { clientX: 0, clientY: 0, shiftKey: false, metaKey: false, ctrlKey: false },
        { time, pitch },
        {
          pxPerSecond: 100,
          rowHeight: 10,
        },
      );
      if (dx !== undefined) pointer.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: dx, clientY: 0 }));
      pointer.dispatchEvent(new Event("pointerup"));
      flush();
    };
    const find = (id: number) => notes().find((item) => item.id === id);
    return { doc, editing, selection, press, click, drag, draw, find, notes, onReveal, onRefused };
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

  it("draws a note as long as the drag, in the line it falls in, then types its syllable", () => {
    const { draw, notes, editing, selection, doc } = setup();
    draw(2.02, 60, 30);
    const added = notes().find((note) => note.pitch === 60)!;
    // Line 10's break is at its default, right where its last note ends (1.8 s): 2 s is in line 11.
    expect(added).toMatchObject({ start: 2, duration: expect.closeTo(0.3, 9), lyric: "", lineId: 11 });
    expect(selection()).toEqual([added.id]);
    expect(editing.editingLyric()).toBe(added.id);
    expect(doc.undoLabel()).toBe("Add note");
    editing.finishLyric("la ");
    flush();
    expect(notes().find((note) => note.id === added.id)!.lyric).toBe("la ");
    expect(editing.editingLyric()).toBeNull();
  });

  it("adds a short note with a click or a double-click, then as long as the last drawn or clicked", () => {
    const { draw, editing, notes, click } = setup();
    draw(4, 70);
    editing.finishLyric(null);
    draw(6, 72, 40);
    editing.finishLyric(null);
    editing.emptyDoubleClick({ time: 5, pitch: 71 });
    editing.finishLyric(null);
    click(102);
    draw(7, 73);
    flush();
    expect(
      notes()
        .filter((note) => note.pitch >= 70)
        .map((note) => [note.start, note.duration]),
    ).toEqual([
      [4, expect.closeTo(0.15, 9)],
      [5, expect.closeTo(0.4, 9)],
      [6, expect.closeTo(0.4, 9)],
      [7, expect.closeTo(0.3, 9)],
    ]);
  });

  it("splits a note where the Split tool clicks, or every note at that time with Shift", () => {
    const { editing, notes, find, selection } = setup();
    editing.hover(find(101)!, 1.62);
    flush();
    expect(editing.cut()).toEqual({ noteId: 101, time: expect.closeTo(1.6, 9), valid: true });
    editing.splitAt(find(101)!, 1.62, false);
    flush();
    expect(find(101)!.duration).toBeCloseTo(0.1, 9);
    const second = notes().find((note) => note.lyric === "~")!;
    expect(second.start).toBeCloseTo(1.6, 9);
    expect(selection()).toEqual([101, second.id]);
    editing.hover(find(100)!, 1.01);
    flush();
    expect(editing.cut()!.valid).toBe(false);
  });

  it("splits at the playhead with Cmd/Ctrl+K, and says so when it can't", () => {
    const { press, find, onRefused, notes } = setup(1.1);
    expect(press("k", { metaKey: true })).toBe(true);
    expect(find(100)!.duration).toBeCloseTo(0.1, 9);
    expect(notes()).toHaveLength(4);
    const far = setup(2.5);
    far.press("k", { ctrlKey: true });
    expect(far.onRefused).toHaveBeenCalled();
    expect(onRefused).not.toHaveBeenCalled();
  });

  it("types syllables one after another with Tab, from Enter on a selected note", () => {
    const { click, press, editing, find } = setup();
    click(100);
    press("Enter");
    expect(editing.editingLyric()).toBe(100);
    editing.finishLyric("Wir ", 1);
    flush();
    expect(find(100)!.lyric).toBe("Wir ");
    expect(editing.editingLyric()).toBe(101);
    editing.finishLyric(null);
    flush();
    expect(find(101)!.lyric).toBe("walk");
  });

  it("brings back the new notes' selection on redo after adding, splitting and merging", () => {
    const { draw, editing, doc, selection, find, click, press } = setup();
    draw(4, 70);
    editing.finishLyric(null);
    const added = selection()[0]!;
    doc.undo();
    flush();
    doc.redo();
    flush();
    expect(selection()).toEqual([added]);

    editing.splitAt(find(101)!, 1.62, false);
    flush();
    const parts = selection();
    expect(parts).toHaveLength(2);
    doc.undo();
    flush();
    doc.redo();
    flush();
    expect(selection()).toEqual(parts);

    click(100);
    click(101, { shiftKey: true });
    press("m");
    doc.undo();
    flush();
    expect(selection()).toEqual([100, 101]);
    doc.redo();
    flush();
    expect(selection()).toEqual([100]);
  });

  it("doesn't record a syllable left as it was", () => {
    const { click, press, editing, doc, find } = setup();
    click(100);
    press("Enter");
    editing.finishLyric("We ");
    flush();
    expect(doc.undoLabel()).toBeNull();
    expect(find(100)!.edited).toBe(false);
  });

  it("adds to the singer of the last note pressed, even after a click deselected it", () => {
    const duet: EditorChart = {
      ...chart,
      singers: [
        ...chart.singers,
        {
          id: 2,
          index: 2,
          name: null,
          lines: [{ id: 20, switchStart: null, switchEnd: null, notes: [note(200, 2, "da")] }],
        },
      ],
    };
    const { click, editing, notes } = setup(0, duet);
    click(200);
    // A double-click's first click deselects; the note still goes to singer 2.
    editing.emptyClick();
    editing.emptyDoubleClick({ time: 2.5, pitch: 72 });
    flush();
    expect(notes().find((item) => item.pitch === 72)).toMatchObject({ singer: 2, lineId: 20 });
  });

  it("stops a drag without changing anything when cancelled (before an undo)", () => {
    const { drag, editing, find, doc } = setup();
    drag(101, "body", [[50, 0]], false);
    editing.cancel();
    flush();
    expect(editing.drag()).toBeNull();
    expect(editing.busy()).toBe(false);
    expect(find(101)!.start).toBe(1.5);
    expect(doc.undoLabel()).toBeNull();
  });

  it("clears the cut line after a split, and says why when there's no room to add a note", () => {
    const { editing, find, onRefused } = setup();
    editing.hover(find(101)!, 1.62);
    editing.splitAt(find(101)!, 1.62, false);
    flush();
    expect(editing.cut()).toBeNull();
    // 10 s is the song's end.
    editing.emptyDoubleClick({ time: 10, pitch: 60 });
    flush();
    expect(onRefused).toHaveBeenCalledWith(expect.stringContaining("no room"));
  });
});
