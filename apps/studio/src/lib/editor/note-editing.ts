/**
 * Editing notes with the Select tool: clicks, drags, the selection box and the keys, turned into selections and
 * document edits (`edits.ts` has the rules).
 *
 * A press on a note selects it (Shift: a range to it, Cmd/Ctrl: toggles it); one on a selected note keeps the
 * selection, so a drag moves all of it, and becomes "just this note" when it doesn't drag. Dragging the body moves the
 * notes in time and pitch (Shift: only the way it went first), an edge moves their starts or ends; on whole grid steps
 * and semitones, within the limits. A drag is a preview (`drag`) until it is let go, then one edit; Esc cancels it.
 *
 * Draw (D): a drag on empty space draws a note, a click adds one as long as the last note drawn or clicked (FL Studio's
 * way; a short one at first). Split (C): a cut line follows the pointer on
 * a note (`cut`), a click splits there (Shift: every note at that time). In any tool, a double-click on empty space adds
 * a note, Cmd/Ctrl+K splits at the playhead. A note added or double-clicked gets its syllable typed in place
 * (`editingLyric`); Enter edits the selected note's, Tab goes on to the next note.
 *
 * Copy, cut and paste (`clipboard.ts`): the selected notes, with their line breaks; a paste goes in at the playhead for
 * the active singer, as one edit keeping the line rules, and is selected.
 *
 * Keys work on the selection:
 * - ↑ / ↓ pitch (Shift: an octave), ← / → move a grid step, Shift+← / → shorter or longer
 * - Tab / Shift+Tab next or previous note, Cmd/Ctrl+A all notes, Esc none, Enter edit the syllable
 * - Delete / Backspace delete, M merge, G golden, R rap, F freestyle
 *
 * Holding an arrow makes one undo step.
 */

import { createSignal } from "solid-js";

import type { AutoScroll } from "./autoscroll";
import type { DrawnNote } from "./chart";
import { type Clip, copyNotes, pasteNotes } from "./clipboard";
import type { ChartDocument } from "./document";
import {
  addNote,
  canSplit,
  defaultLength,
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
  onGrid,
  snapDelta,
  splitNote,
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

/** What was copied last, in any project this session (the system clipboard has its text). */
let clip: Clip | null = null;

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
  /** Scrolls the view while a drag is at the roll's edge (`autoscroll.ts`). */
  autoScroll?: AutoScroll;
  /** Where the view starts (seconds): a drag counts how far it scrolled. */
  viewStart?: () => number;
}) {
  /** Where the last plain or Cmd-click was, for Shift-click ranges. */
  let anchor: number | null = null;
  /** The singer (index) of the last note pressed: new notes go to them. */
  let lastSinger: number | null = null;
  const [drag, setDrag] = createSignal<DragPreview | null>(null);
  /** A note being drawn (Draw tool), as it would be added. */
  const [drawing, setDrawing] = createSignal<{ start: number; duration: number; pitch: number } | null>(null);
  /** Where the Split tool would cut the note under the pointer, and whether it can. */
  const [cut, setCut] = createSignal<{ noteId: number; time: number; valid: boolean } | null>(null);
  /** The note whose syllable is being typed. */
  const [editingLyric, setEditingLyric] = createSignal<number | null>(null);
  /** How long a note added with a click is: the last one drawn or clicked (null: the default). */
  let lastLength: number | null = null;
  const clickLength = () => lastLength ?? defaultLength(chart());
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
    lastSinger = next.singer;
    select([next.id]);
    options.onReveal(next);
  };

  /**
   * The singer new notes go to: the last one whose note was pressed (so a double-click, whose first click deselects,
   * still adds to it), else the first.
   */
  const singerFor = (): number | null => {
    const singers = chart().singers;
    return (singers.find((singer) => singer.index === lastSinger) ?? singers[0])?.id ?? null;
  };

  /** Adds a note, selects it and starts typing its syllable. */
  const add = (start: number, duration: number, pitch: number) => {
    const singerId = singerFor();
    if (singerId === null) {
      options.onRefused("This chart has no singer to add notes to.");
      return;
    }
    const current = chart();
    let id: number | null = null;
    options
      .doc()
      .edit("Add note", (tx) => (id = addNote(tx, current, { singerId, start, duration, pitch }, options.length())), {
        selectionAfter: () => (id === null ? [] : [id]),
      });
    if (id === null) {
      options.onRefused("There's no room for a note here: it would cross a line break or the song's end.");
      return;
    }
    setEditingLyric(id);
  };

  /** Splits `targets` at `time` (those it can), as one edit; selects both parts of each. */
  const split = (targets: DrawnNote[], time: number) => {
    const current = chart();
    const fitting = targets.filter((note) => canSplit(current, note, time));
    if (fitting.length === 0) return false;
    const seconds: number[] = [];
    options.doc().edit(
      `Split ${count(fitting.map((note) => note.id))}`,
      (tx) => {
        for (const note of fitting) {
          const second = splitNote(tx, current, note.id, time);
          if (second !== null) seconds.push(second);
        }
      },
      { selectionAfter: () => [...fitting.map((note) => note.id), ...seconds] },
    );
    setCut(null);
    return true;
  };

  /** Starts typing a note's syllable (and selects it). */
  const startLyric = (id: number) => {
    select([id]);
    setEditingLyric(id);
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
    const startView = options.viewStart?.() ?? 0;
    let dragging = false;
    /** With Shift, the way the drag went first: only that changes. */
    let locked: "time" | "pitch" | null = null;
    /** The preview as last set (the signal is written on the next microtask; a release can come first). */
    let latest: DragPreview | null = null;

    const move = (event: Event) => {
      const pointer = event as PointerEvent;
      const dx = pointer.clientX - press.clientX;
      const dy = pointer.clientY - press.clientY;
      if (!dragging && Math.hypot(dx, dy) < DRAG_PX) return;
      dragging = true;
      options.autoScroll?.track(pointer.clientX, () => move(event));
      /** How far the view scrolled since the press (the notes go along). */
      const scrolled = (options.viewStart?.() ?? startView) - startView;
      if (pointer.shiftKey && part === "body") locked ??= Math.abs(dx) >= Math.abs(dy) ? "time" : "pitch";
      else locked = null;
      const seconds = locked === "pitch" ? 0 : snapDelta(dx / scale.pxPerSecond + scrolled, unit, time);
      const semitones = part !== "body" || locked === "time" ? 0 : snapDelta(-dy / scale.rowHeight, 1, pitch);
      const steps = Math.round(seconds / unit);
      const label =
        part === "body"
          ? [stepsLabel(steps), pitchName(note.pitch + semitones)].filter(Boolean).join(" · ")
          : stepsLabel(steps) || "±0";
      latest = { ids, part, time: seconds, pitch: semitones, anchor: note.id, label };
      setDrag(latest);
    };
    const stop = () => {
      options.autoScroll?.end();
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", cancel);
      target.removeEventListener("blur", cancel);
      cancelDrag = null;
      setDrag(null);
    };
    const up = () => {
      const preview = latest;
      stop();
      if (preview && (preview.time !== 0 || preview.pitch !== 0)) commitDrag(preview);
      else if (!dragging && justThis) select([note.id]);
    };
    const cancel = () => stop();
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", cancel);
    // A release outside the window may never arrive: losing focus ends the drag too.
    target.addEventListener("blur", cancel);
    cancelDrag = stop;
  };

  return {
    /** The drag in progress, if any. */
    drag,
    /** The singer (id) new notes and line breaks go to: the one whose note was touched last, else the first. */
    activeSinger: () => singerFor(),
    /** Whether a drag or a drawing is in progress (Esc stops it before anything else). */
    busy: () => cancelDrag !== null,
    /**
     * Stops a drag or drawing without changing anything: before undo and redo (its limits were worked out for the
     * chart as it was) and when the editor goes away (its listeners are on the window).
     */
    cancel: () => cancelDrag?.(),
    drawing,
    cut,
    editingLyric,

    /** Draw tool: a press on empty space at `at`; a drag sets the new note's length, a click adds a short one. */
    drawDown(press: PointerPress, at: { time: number; pitch: number }, scale: RollScale) {
      cancelDrag?.();
      const current = chart();
      const unit = gridStep(current);
      const start = Math.max(0, onGrid(current, at.time));
      const target = options.pointerTarget ?? window;
      const startView = options.viewStart?.() ?? 0;
      let dragging = false;
      let drawn: { start: number; duration: number; pitch: number } | null = null;
      const move = (event: Event) => {
        const pointer = event as PointerEvent;
        const dx = pointer.clientX - press.clientX;
        if (!dragging && Math.abs(dx) < DRAG_PX) return;
        dragging = true;
        options.autoScroll?.track(pointer.clientX, () => move(event));
        const scrolled = (options.viewStart?.() ?? startView) - startView;
        const end = Math.min(options.length(), onGrid(current, at.time + dx / scale.pxPerSecond + scrolled));
        drawn = { start, duration: Math.max(unit, end - start), pitch: at.pitch };
        setDrawing(drawn);
      };
      const stop = () => {
        options.autoScroll?.end();
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", stop);
        target.removeEventListener("blur", stop);
        cancelDrag = null;
        setDrawing(null);
      };
      const up = () => {
        stop();
        if (drawn) {
          lastLength = drawn.duration;
          add(drawn.start, drawn.duration, drawn.pitch);
        } else if (!dragging) add(start, clickLength(), at.pitch);
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", stop);
      target.addEventListener("blur", stop);
      cancelDrag = stop;
    },

    /** A double-click on empty space (any tool): adds a short note there. */
    emptyDoubleClick(at: { time: number; pitch: number }) {
      add(Math.max(0, onGrid(chart(), at.time)), clickLength(), at.pitch);
    },

    /** Split tool: the pointer is over `note` at `time` (or over none). */
    hover(note: DrawnNote | null, time: number) {
      if (!note) {
        setCut(null);
        return;
      }
      const current = chart();
      setCut({ noteId: note.id, time: onGrid(current, time), valid: canSplit(current, note, time) });
    },

    /** Split tool: a click on `note` at `time` splits it there, or every note at that time with Shift. */
    splitAt(note: DrawnNote, time: number, every: boolean) {
      lastSinger = note.singer;
      const targets = every
        ? options.notes().filter((item) => item.start < time && item.start + item.duration > time)
        : [note];
      split(targets, time);
    },

    /** Double-click on a note: type its syllable. */
    noteDoubleClick(note: DrawnNote) {
      startLyric(note.id);
    },

    /** The syllable typed (null: cancelled); `move` goes on to the next (1) or previous (-1) note's. */
    finishLyric(text: string | null, move?: 1 | -1) {
      const id = editingLyric();
      setEditingLyric(null);
      if (id === null) return;
      // An unchanged syllable isn't an edit (nor does it make the note count as changed by hand).
      if (text !== null)
        options.doc().edit("Change syllable", (tx) => {
          if (tx.note(id)?.lyric !== text) tx.updateNote(id, { lyric: text });
        });
      if (!move) return;
      const next = adjacentNote(options.notes(), [id], move, 0);
      if (!next) return;
      startLyric(next.id);
      options.onReveal(next);
    },

    /**
     * A press on a note (`part`: its body or an edge): selects as a click does, then follows the pointer for a drag.
     */
    noteDown(note: DrawnNote, press: PointerPress, part: NotePart = "body", scale?: RollScale) {
      cancelDrag?.();
      lastSinger = note.singer;
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
        lastLength = note.duration;
        if (!next.includes(note.id)) next = [note.id];
      }
      select(next);
      const justThis = !press.shiftKey && next.length > 1;
      if (scale) follow(note, press, part, scale, next, justThis);
    },

    /**
     * Copies the selected notes; returns the text for the system clipboard, null when nothing is selected (a copy
     * elsewhere can go on), or false when it can't copy them (it said why; nothing else should copy).
     */
    copySelection(): string | null | false {
      const ids = selected();
      if (ids.length === 0) return null;
      const copied = copyNotes(chart(), new Set(ids));
      if (!copied) {
        options.onRefused("Copy one singer's notes at a time.");
        return false;
      }
      clip = copied;
      return copied.text;
    },

    /** Copies the selected notes and deletes them; returns what `copySelection` does. */
    cutSelection(): string | null | false {
      const ids = selected();
      const text = this.copySelection();
      if (typeof text !== "string") return text;
      options.doc().edit(`Cut ${count(ids)}`, (tx) => deleteNotes(tx, chart(), new Set(ids)), { selection: [] });
      return text;
    },

    /**
     * Pastes what was copied at the playhead, for the active singer, if the system clipboard still has its text
     * (`text`; something else copied since isn't notes). Returns whether it did.
     */
    pasteClip(text?: string): boolean {
      if (!clip || (text !== undefined && text !== clip.text)) return false;
      const singerId = singerFor();
      if (singerId === null) {
        options.onRefused("This chart has no singer to add notes to.");
        return true;
      }
      const pasted = clip;
      const target = { singerId, at: options.playheadTime(), length: options.length() };
      let ids: number[] = [];
      options
        .doc()
        .edit(
          `Paste ${count(pasted.notes.map((_, i) => i))}`,
          (tx) => (ids = pasteNotes(tx, chart(), pasted, target)),
          { selectionAfter: () => ids },
        );
      if (ids.length === 0) options.onRefused("There's no room to paste here: it would be past the song's end.");
      return true;
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
      if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        // Split at the playhead: the selected notes it is in, or any it is in.
        const time = options.playheadTime();
        const ids = selected();
        const inside = options
          .notes()
          .filter((note) => note.start < time && note.start + note.duration > time)
          .filter((note) => ids.length === 0 || ids.includes(note.id));
        if (!split(inside, time))
          options.onRefused("Put the playhead inside a note, a step or more from its ends, to split it.");
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
      if (event.key === "Enter" && ids.length === 1) {
        startLyric(ids[0]!);
        return true;
      }
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
        options.doc().edit(`Merge ${count(ids)}`, (tx) => (merged = mergeNotes(tx, chart(), new Set(ids))), {
          selectionAfter: () => (merged === null ? ids : [merged]),
        });
        if (merged === null) options.onRefused("Select notes next to each other in one line to merge them.");
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
