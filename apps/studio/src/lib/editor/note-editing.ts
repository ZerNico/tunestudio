/**
 * Editing notes with the Select tool: clicks, drags, the selection box and the keys, turned into selections and
 * document edits (`edits.ts` has the rules).
 *
 * A press on a note selects it (Shift: a range to it, Cmd/Ctrl: toggles it); one on a selected note keeps the
 * selection, so a drag moves all of it, and becomes "just this note" when it doesn't drag. Dragging the body moves the
 * notes in time and pitch (Shift: only the way it went first), an edge moves their starts or ends; on whole grid steps
 * and semitones, within the limits. A drag is a preview (`drag`) until it is let go, then one edit; Esc cancels it.
 *
 * Keys work on the selection:
 * - ↑ / ↓ pitch (Shift: an octave), ← / → move a grid step, Shift+← / → shorter or longer
 * - Tab / Shift+Tab next or previous note, Cmd/Ctrl+A all notes, Esc none
 * - Delete / Backspace delete, M merge, G golden, R rap, F freestyle
 *
 * Holding an arrow makes one undo step.
 */

import { createSignal } from "solid-js";

import type { DrawnNote } from "./chart";
import type { ChartDocument } from "./document";
import {
  deleteNotes,
  fits,
  gridStep,
  lengthLimits,
  mergeNotes,
  moveLimits,
  moveNotes,
  type NoteFlag,
  pitchFits,
  pitchLimits,
  placeNotes,
  resizeNotes,
  resizeStarts,
  shiftPitch,
  snapDelta,
  startLimits,
  toggleFlag,
} from "./edits";
import { adjacentNote, notesInBox, rangeSelection, toggled } from "./selection";
import { pitchName } from "./view";

const FLAG_KEYS: Record<string, { flag: NoteFlag; label: string }> = {
  g: { flag: "golden", label: "Golden" },
  r: { flag: "rap", label: "Rap" },
  f: { flag: "freestyle", label: "Freestyle" },
};

/** A press that moves less than this is a click, not a drag (px). */
const DRAG_PX = 3;

const count = (ids: readonly number[]) => (ids.length === 1 ? "note" : `${ids.length} notes`);

/** Which part of a note a press is on: its body moves it, an edge moves its start or end. */
export type NotePart = "body" | "start" | "end";

/** A drag in progress: how far it has moved the notes so far, and what to say about it at `anchor`. */
export interface DragPreview {
  ids: ReadonlySet<number>;
  part: NotePart;
  /** Seconds and semitones, on whole steps. */
  time: number;
  pitch: number;
  /** The note that was pressed, and the label shown at it ("+2 steps · D4"). */
  anchor: number;
  label: string;
}

/** A note as the preview shows it. */
export function previewed<T extends { id: number; start: number; duration: number; pitch: number }>(
  note: T,
  drag: DragPreview | null,
): T {
  if (!drag?.ids.has(note.id)) return note;
  if (drag.part === "body") return { ...note, start: note.start + drag.time, pitch: note.pitch + drag.pitch };
  if (drag.part === "start") return { ...note, start: note.start + drag.time, duration: note.duration - drag.time };
  return { ...note, duration: note.duration + drag.time };
}

/** "+2 steps", "−1 step" (empty for none). */
function stepsLabel(steps: number): string {
  if (steps === 0) return "";
  return `${steps > 0 ? "+" : "−"}${Math.abs(steps)} ${Math.abs(steps) === 1 ? "step" : "steps"}`;
}

/** What a gesture needs to turn pixels into seconds and semitones. */
export interface RollScale {
  pxPerSecond: number;
  rowHeight: number;
}

export interface PointerPress {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export function createNoteEditing(options: {
  doc: () => ChartDocument<number[]>;
  /** The notes as drawn, by start time. */
  notes: () => DrawnNote[];
  selection: () => number[];
  setSelection: (ids: number[]) => void;
  /** The song's length (seconds): notes stay inside it. */
  length: () => number;
  playheadTime: () => number;
  /** Tab went to a note: show it (and put the playhead on it unless playing). */
  onReveal: (note: DrawnNote) => void;
  /** Something couldn't be done; say why. */
  onRefused: (message: string) => void;
  /** Where pointer moves and releases are heard during a drag (the window; tests pass their own). */
  pointerTarget?: EventTarget;
}) {
  /** Where the last plain or Cmd-click was, for Shift-click ranges. */
  let anchor: number | null = null;
  const [drag, setDrag] = createSignal<DragPreview | null>(null);
  /** Ends the drag in progress without changing anything. */
  let cancelDrag: (() => void) | null = null;

  const selected = () => {
    const present = new Set(options.notes().map((note) => note.id));
    return options.selection().filter((id) => present.has(id));
  };

  const select = (ids: number[]) => options.setSelection(ids);
  const chart = () => options.doc().chart();

  const nudge = (ids: number[], delta: number) => {
    const current = chart();
    const limits = moveLimits(placeNotes(current, options.length()), new Set(ids));
    if (!fits(delta, limits)) return;
    options.doc().edit(`Move ${count(ids)}`, (tx) => moveNotes(tx, current, ids, delta), {
      merge: `move:${ids.join()}`,
    });
  };

  const lengthen = (ids: number[], delta: number) => {
    const current = chart();
    const limits = lengthLimits(placeNotes(current, options.length()), new Set(ids), gridStep(current));
    if (!fits(delta, limits)) return;
    options.doc().edit(`Change length of ${count(ids)}`, (tx) => resizeNotes(tx, current, ids, delta), {
      merge: `length:${ids.join()}`,
    });
  };

  const repitch = (ids: number[], semitones: number) => {
    if (!pitchFits(chart(), new Set(ids), semitones)) return;
    options.doc().edit(`Change pitch of ${count(ids)}`, (tx) => shiftPitch(tx, ids, semitones), {
      merge: `pitch:${ids.join()}`,
    });
  };

  const step = (direction: 1 | -1) => {
    const next = adjacentNote(options.notes(), selected(), direction, options.playheadTime());
    if (!next) return;
    anchor = next.id;
    select([next.id]);
    options.onReveal(next);
  };

  /** Writes a finished drag as one edit. */
  const commitDrag = (preview: DragPreview) => {
    const current = chart();
    const ids = [...preview.ids];
    if (preview.part === "body") {
      options.doc().edit(`Move ${count(ids)}`, (tx) => {
        moveNotes(tx, current, ids, preview.time);
        shiftPitch(tx, ids, preview.pitch);
      });
    } else if (preview.part === "start") {
      options.doc().edit(`Change start of ${count(ids)}`, (tx) => resizeStarts(tx, current, ids, preview.time));
    } else {
      options.doc().edit(`Change length of ${count(ids)}`, (tx) => resizeNotes(tx, current, ids, preview.time));
    }
  };

  /** Follows a press on `note` until it is let go: a drag, or a click that selects just the note. */
  const follow = (
    note: DrawnNote,
    press: PointerPress,
    part: NotePart,
    scale: RollScale,
    selection: number[],
    justThis: boolean,
  ) => {
    const current = chart();
    const ids = new Set(selection);
    if (!ids.has(note.id)) return;
    const unit = gridStep(current);
    const placed = placeNotes(current, options.length());
    const time =
      part === "body"
        ? moveLimits(placed, ids)
        : part === "start"
          ? startLimits(placed, ids, unit)
          : lengthLimits(placed, ids, unit);
    const pitch = pitchLimits(current, ids);
    const target = options.pointerTarget ?? window;
    let dragging = false;
    /** With Shift, the way the drag went first: only that changes. */
    let locked: "time" | "pitch" | null = null;

    const move = (event: Event) => {
      const pointer = event as PointerEvent;
      const dx = pointer.clientX - press.clientX;
      const dy = pointer.clientY - press.clientY;
      if (!dragging && Math.hypot(dx, dy) < DRAG_PX) return;
      dragging = true;
      if (pointer.shiftKey && part === "body") locked ??= Math.abs(dx) >= Math.abs(dy) ? "time" : "pitch";
      else locked = null;
      const seconds = locked === "pitch" ? 0 : snapDelta(dx / scale.pxPerSecond, unit, time);
      const semitones = part !== "body" || locked === "time" ? 0 : snapDelta(-dy / scale.rowHeight, 1, pitch);
      const steps = Math.round(seconds / unit);
      const label =
        part === "body"
          ? [stepsLabel(steps), pitchName(note.pitch + semitones)].filter(Boolean).join(" · ")
          : stepsLabel(steps) || "±0";
      setDrag({ ids, part, time: seconds, pitch: semitones, anchor: note.id, label });
    };
    const stop = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", cancel);
      cancelDrag = null;
      setDrag(null);
    };
    const up = () => {
      const preview = drag();
      stop();
      if (preview && (preview.time !== 0 || preview.pitch !== 0)) commitDrag(preview);
      else if (!dragging && justThis) select([note.id]);
    };
    const cancel = () => stop();
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", cancel);
    cancelDrag = stop;
  };

  return {
    /** The drag in progress, if any. */
    drag,

    /**
     * A press on a note (`part`: its body or an edge): selects as a click does, then follows the pointer for a drag.
     */
    noteDown(note: DrawnNote, press: PointerPress, part: NotePart = "body", scale?: RollScale) {
      cancelDrag?.();
      if (press.metaKey || press.ctrlKey) {
        anchor = note.id;
        select(toggled(selected(), note.id));
        return;
      }
      // The selection is written on the next microtask; the drag goes on with what it becomes.
      let next = selected();
      if (press.shiftKey && anchor !== null) {
        next = [...new Set([...next, ...rangeSelection(options.notes(), anchor, note.id)])];
      } else {
        anchor = note.id;
        if (!next.includes(note.id)) next = [note.id];
      }
      select(next);
      const justThis = !press.shiftKey && next.length > 1;
      if (scale) follow(note, press, part, scale, next, justThis);
    },

    /** A click on empty space: nothing selected any more. */
    emptyClick() {
      select([]);
    },

    /** A selection box: the notes it touches, or those added to the selection. */
    box(area: { from: number; to: number; low: number; high: number }, add: boolean) {
      const inside = notesInBox(options.notes(), area);
      select(add ? [...new Set([...selected(), ...inside])] : inside);
    },

    /** Handles a key for the selection; returns whether it did (so the caller prevents the default). */
    key(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
      if (cancelDrag) {
        // During a drag only Esc counts: it puts the notes back.
        if (event.key === "Escape") cancelDrag();
        return event.key === "Escape";
      }
      const command = event.metaKey || event.ctrlKey;
      if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
        select(options.notes().map((note) => note.id));
        return true;
      }
      if (command || event.altKey) return false;
      if (event.key === "Tab") {
        step(event.shiftKey ? -1 : 1);
        return true;
      }
      const ids = selected();
      if (event.key === "Escape") {
        if (ids.length === 0) return false;
        select([]);
        return true;
      }
      if (ids.length === 0) return false;
      switch (event.key) {
        case "ArrowUp":
        case "ArrowDown":
          repitch(ids, (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 12 : 1));
          return true;
        case "ArrowLeft":
        case "ArrowRight": {
          const delta = (event.key === "ArrowRight" ? 1 : -1) * gridStep(chart());
          if (event.shiftKey) lengthen(ids, delta);
          else nudge(ids, delta);
          return true;
        }
        case "Delete":
        case "Backspace":
          options.doc().edit(`Delete ${count(ids)}`, (tx) => deleteNotes(tx, chart(), new Set(ids)), { selection: [] });
          return true;
      }
      const key = event.key.toLowerCase();
      if (key === "m" && !event.shiftKey) {
        let merged: number | null = null;
        options.doc().edit(`Merge ${count(ids)}`, (tx) => (merged = mergeNotes(tx, chart(), new Set(ids))));
        if (merged === null) options.onRefused("Select notes next to each other in one line to merge them.");
        else select([merged]);
        return true;
      }
      const flag = FLAG_KEYS[key];
      if (flag && !event.shiftKey) {
        options.doc().edit(`${flag.label} ${count(ids)}`, (tx) => toggleFlag(tx, chart(), new Set(ids), flag.flag));
        return true;
      }
      return false;
    },
  };
}
