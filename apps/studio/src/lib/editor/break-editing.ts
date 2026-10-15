/**
 * Editing line breaks in the lane above the roll (`breaks.ts` has the rules). A marker is pressed to select it and
 * dragged to move it: a preview (`drag`, with a label) until it is let go, then one edit; Esc cancels. A double-click
 * on a marker removes it, one on the lane adds a break there. With a marker selected, Delete removes it; B adds a break
 * at the playhead, in the nearest gap. New breaks go to the singer whose note was touched last.
 */

import { createSignal } from "solid-js";

import { addBreak, breakLanding, breakRange, moveBreak, nearestGap, removeBreak } from "./breaks";
import type { LineBreak } from "./chart";
import type { ChartDocument } from "./document";
import { formatTime } from "./view";

/** A press that moves less than this is a click, not a drag (px). */
const DRAG_PX = 3;

/** A break being dragged: where it would go, and what to say about it. */
export interface BreakDrag {
  lineId: number;
  time: number;
  label: string;
}

export function createBreakEditing(options: {
  doc: () => ChartDocument<number[]>;
  /** The singer (id) new breaks go to. */
  singer: () => number | null;
  playheadTime: () => number;
  /** A break was selected: the notes aren't any more. */
  onSelect: () => void;
  onRefused: (message: string) => void;
  /** Where pointer moves and releases are heard during a drag (the window; tests pass their own). */
  pointerTarget?: EventTarget;
}) {
  /** The selected break, by the line it ends. */
  const [selected, setSelected] = createSignal<number | null>(null);
  const [drag, setDrag] = createSignal<BreakDrag | null>(null);
  let cancelDrag: (() => void) | null = null;
  const chart = () => options.doc().chart();

  const select = (lineId: number | null) => {
    setSelected(lineId);
    if (lineId !== null) options.onSelect();
  };

  const remove = (lineId: number) => {
    const current = chart();
    options.doc().edit("Remove line break", (tx) => void removeBreak(tx, current, lineId));
    setSelected(null);
  };

  const add = (time: number) => {
    const singerId = options.singer();
    const current = chart();
    let added = false;
    if (singerId !== null) {
      options.doc().edit("Add line break", (tx) => void (added = addBreak(tx, current, singerId, time)));
    }
    if (!added) options.onRefused("Put the line break between two notes of a line.");
  };

  /** How many notes a break at `time` moves to the other line. */
  const moved = (lineId: number, time: number) => {
    const singer = chart().singers.find((item) => item.lines.some((line) => line.id === lineId));
    const lines = singer?.lines.filter((line) => line.notes.length > 0) ?? [];
    const index = lines.findIndex((line) => line.id === lineId);
    const line = lines[index];
    const next = lines[index + 1];
    if (!line || !next) return 0;
    return (
      line.notes.filter((note) => note.start >= time).length + next.notes.filter((note) => note.start < time).length
    );
  };

  return {
    selected,
    drag,
    /** Whether a break is being dragged (Esc stops it before anything else). */
    busy: () => cancelDrag !== null,
    /** Stops a drag without changing anything (before undo and redo, and when the editor goes away). */
    cancel: () => cancelDrag?.(),
    /** Nothing selected (notes were). */
    deselect: () => setSelected(null),

    /** A press on a marker: selects it, then follows the pointer for a drag. */
    breakDown(item: LineBreak, press: { clientX: number }, pxPerSecond: number) {
      cancelDrag?.();
      select(item.lineId);
      const current = chart();
      const range = breakRange(current, item.lineId);
      if (!range) return;
      const target = options.pointerTarget ?? window;
      let dragging = false;
      let latest: BreakDrag | null = null;
      const move = (event: Event) => {
        const dx = (event as PointerEvent).clientX - press.clientX;
        if (!dragging && Math.abs(dx) < DRAG_PX) return;
        dragging = true;
        // Only where it may go: on the grid, never inside a note.
        const time = breakLanding(current, item.lineId, item.time + dx / pxPerSecond) ?? item.time;
        const count = moved(item.lineId, time);
        const label = [formatTime(time), count === 0 ? "" : `${count} ${count === 1 ? "note moves" : "notes move"}`]
          .filter(Boolean)
          .join(" · ");
        latest = { lineId: item.lineId, time, label };
        setDrag(latest);
      };
      const stop = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", stop);
        cancelDrag = null;
        setDrag(null);
      };
      const up = () => {
        const preview = latest;
        stop();
        if (preview) {
          options.doc().edit("Move line break", (tx) => void moveBreak(tx, current, preview.lineId, preview.time));
        }
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", stop);
      cancelDrag = stop;
    },

    /** A double-click on a marker removes it. */
    breakDoubleClick(item: LineBreak) {
      remove(item.lineId);
    },

    /** A double-click on the lane adds a break there. */
    laneDoubleClick(time: number) {
      add(time);
    },

    /** Handles a key; returns whether it did. */
    key(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
      if (cancelDrag) {
        if (event.key === "Escape") cancelDrag();
        return event.key === "Escape";
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      if (event.key.toLowerCase() === "b" && !event.shiftKey) {
        const singerId = options.singer();
        const at = singerId === null ? null : nearestGap(chart(), singerId, options.playheadTime());
        if (at === null) options.onRefused("There's no gap between notes here for a line break.");
        else add(at);
        return true;
      }
      const lineId = selected();
      if (lineId === null) return false;
      if (event.key === "Escape") {
        setSelected(null);
        return true;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        remove(lineId);
        return true;
      }
      return false;
    },
  };
}
