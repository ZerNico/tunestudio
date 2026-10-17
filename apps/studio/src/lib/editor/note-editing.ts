/**
 * Editing notes: clicks, drags, the selection box and the keys of every tool, the clipboard, auto pitch's result and
 * typing syllables, turned into selections and document edits (`edits.ts` has the rules; `drag.ts` follows the drags).
 *
 * A press on a note selects it (Shift: a range to it, Cmd/Ctrl: toggles it); one on a selected note keeps the
 * selection, so a drag moves all of it, and becomes "just this note" when it doesn't drag. Dragging the body moves the
 * notes in time and pitch (Shift: only the way it went first), an edge moves their starts or ends; on whole grid steps
 * and semitones, within the limits. A drag is a preview (`drag`) until it is let go, then one edit; Esc cancels it.
 *
 * Draw (D): a drag on empty space draws a note, a click adds one as long as the last note drawn or clicked (FL Studio's
 * way; a short one at first). Split (C): a cut line follows the pointer on a note (`cut`), a click splits there (Shift:
 * every note at that time). In any tool, a double-click on empty space adds a note, Cmd/Ctrl+K splits at the
 * playhead. A note added or double-clicked gets its syllable typed in place (`editingLyric`); Enter edits the selected
 * note's, Tab goes on to the next note.
 *
 * Copy, cut and paste (`clipboard.ts`): the selected notes, with the selected line breaks around them; a paste goes in
 * at the playhead for the active singer, as one edit keeping the line rules, and is selected.
 *
 * The selection is notes and line breaks (`selection.ts`): a selection box takes the breaks it crosses; on a break's
 * marker or its line in the roll, Shift adds it and Cmd/Ctrl adds it or takes it out. Selected breaks move with the
 * notes (a drag of a note or of a selected break moves all of it in time) and are removed with them; breaks that
 * aren't selected keep the notes in their lines. A break pressed alone is dragged on its own (`break-editing.ts`).
 *
 * Keys work on the selection:
 * - ↑ / ↓ pitch (Shift: an octave), ← / → move a grid step (just one break: over notes too), Shift+← / → shorter or
 *   longer
 * - Tab / Shift+Tab next or previous note, Cmd/Ctrl+A everything, Esc nothing, Enter edit the syllable
 * - Delete / Backspace delete, M merge, G golden, R rap, F freestyle, A auto pitch
 *
 * Holding an arrow makes one undo step.
 */

import { createSignal } from "solid-js";

import type { EditorChart } from "~/lib/native/types";

import type { AutoScroll } from "./autoscroll";
import { type DrawnNote, drawnNotes, gridStep, type LineBreak, notesAt, onGrid } from "./chart";
import { type Clip, copyNotes, pasteNotes } from "./clipboard";
import type { ChartDocument } from "./document";
import { type DragMove, followDrag } from "./drag";
import {
  addNote,
  canMerge,
  canSplit,
  defaultLength,
  deleteSelection,
  fits,
  hasFlag,
  lengthLimits,
  mergeNotes,
  type MovePlan,
  moveSelection,
  NOTE_FLAGS,
  type NoteFlag,
  pitchFits,
  pitchLimits,
  placeNotes,
  planMove,
  resizeNotes,
  resizeStarts,
  shiftPitch,
  snapDelta,
  splitNote,
  startLimits,
  toggleFlag,
} from "./edits";
import {
  adjacentNote,
  breaksInBox,
  breaksOnly,
  NOTHING,
  notesInBox,
  notesOnly,
  rangeSelection,
  type Selection,
  toggled,
} from "./selection";
import { otherSinger, singerLabel, singerOf, transferNotes } from "./singers";
import { createSingersView, type SingersView } from "./singers-view";
import { pitchName } from "./view";

/** Held past the roll's top or bottom, a dragged note goes a semitone further this often (ms), the rows growing along. */
const EDGE_STEP_MS = 90;

/** The note type a key toggles (g, r, f), if any. */
const flagFor = (key: string) => NOTE_FLAGS.find((item) => item.key.toLowerCase() === key)?.flag;

/** "note" or "3 notes", for an edit's name. */
const count = (notes: number) => (notes === 1 ? "note" : `${notes} notes`);

/** "3 notes", "line break", "note and 2 line breaks": what an edit of notes and breaks is of. */
const things = (notes: number, breaks: number) =>
  [notes === 0 ? "" : count(notes), breaks === 0 ? "" : breaks === 1 ? "line break" : `${breaks} line breaks`]
    .filter(Boolean)
    .join(" and ");

/** What was copied last, in any project this session (the system clipboard has its text). */
let clip: Clip | null = null;

/** Which part of a note a press is on: its body moves it, an edge moves its start or end. */
export type NotePart = "body" | "start" | "end";

/** A drag in progress: how far it has moved the notes so far, and what to say about it at `anchor`. */
export interface DragPreview {
  ids: ReadonlySet<number>;
  /** A move (`part` "body"): it takes the selected line breaks along, as this says. */
  plan: MovePlan | null;
  part: NotePart;
  /** Seconds and semitones, on whole steps. */
  time: number;
  pitch: number;
  /** The note or break marker that was pressed, and the label shown at it ("+2 steps · D4"). */
  anchor: { note: number } | { lineBreak: number };
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

/** The chart as a drag would leave it: its notes moved or resized, the breaks moving with them where they would go. */
export function previewChart(chart: EditorChart, drag: DragPreview): EditorChart {
  const switches = new Map(
    [...(drag.plan?.breaks ?? [])].flatMap((lineId) => {
      const moved = drag.plan?.breakAt(lineId, drag.time);
      return moved && !moved.auto ? [[lineId, moved.time] as const] : [];
    }),
  );
  return {
    ...chart,
    singers: chart.singers.map((singer) => ({
      ...singer,
      lines: singer.lines.map((line) => ({
        ...line,
        switchStart: switches.get(line.id) ?? line.switchStart,
        notes: line.notes.map((note) => previewed(note, drag)),
      })),
    })),
  };
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
  /**
   * The pitch (fractional; a row's middle is its pitch) at a pointer height, as the roll is drawn now, past its edges
   * too. A drag goes by it rather than by `rowHeight`, so the note stays under the pointer when the rows change while
   * it is dragged.
   */
  pitchAt?: (clientY: number) => number;
  /** The rows drawn now (MIDI): past them, a drag goes on a semitone at a time. */
  rows?: () => { low: number; high: number };
}

export interface PointerPress {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export function createNoteEditing(options: {
  doc: () => ChartDocument<Selection>;
  /** The notes as drawn, by start time. */
  notes: () => DrawnNote[];
  selection: () => Selection;
  setSelection: (selection: Selection) => void;
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
  /** A pitch (MIDI) the user just landed on: a note dragged or moved up or down, or one drawn (to hear it). */
  onPitch?: (midi: number) => void;
  /** A: works out the selected notes' pitch (in main; slow), then hands it to `applyPitches`. */
  onAutoPitch?: (ids: number[]) => void;
  /** Where the view starts (seconds): a drag counts how far it scrolled. */
  viewStart?: () => number;
  /** The line breaks as drawn, by time. */
  breaks: () => LineBreak[];
  /** The active singer (new notes and paste go to them) and the hidden ones; one of its own when not given. */
  singers?: SingersView;
  /** Moving one break on its own, across notes too (`break-editing.ts`): a drag of its marker, or ← / →. */
  oneBreak?: {
    follow: (item: LineBreak, press: PointerPress, pxPerSecond: number) => void;
    nudge: (lineId: number, direction: 1 | -1) => void;
  };
}) {
  /** Where the last plain or Cmd-click was, for Shift-click ranges. */
  let anchor: number | null = null;
  const singers = options.singers ?? createSingersView(() => options.doc().chart());
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
  // Notify controls on press/release even when a click never creates a drag preview.
  const [active, setActive] = createSignal(false);

  /** The selected notes that are there. */
  const selected = () => {
    const present = new Set(options.notes().map((note) => note.id));
    return options.selection().notes.filter((id) => present.has(id));
  };
  /** The selected line breaks that are there (by the line they end). */
  const selectedBreaks = () => {
    const present = new Set(options.breaks().map((item) => item.lineId));
    return options.selection().breaks.filter((id) => present.has(id));
  };

  /**
   * Copies the selected notes (and the selected breaks around them): the breaks it took, null when no note is
   * selected, or false when it can't copy them (it said why).
   */
  const copy = (): number[] | null | false => {
    const ids = selected();
    if (ids.length === 0) return null;
    const copied = copyNotes(chart(), new Set(ids), new Set(selectedBreaks()));
    if (!copied) {
      options.onRefused("Copy one singer's notes at a time.");
      return false;
    }
    clip = copied.clip;
    return copied.breaks;
  };

  const select = (ids: readonly number[], breaks: readonly number[] = []) =>
    options.setSelection({ notes: ids, breaks });
  const chart = () => options.doc().chart();

  const nudge = (ids: number[], breaks: number[], delta: number) => {
    const current = chart();
    const plan = planMove(current, options.length(), new Set(ids), new Set(breaks));
    if (!fits(delta, plan.limits)) return;
    options.doc().edit(`Move ${things(ids.length, breaks.length)}`, (tx) => moveSelection(tx, current, plan, delta), {
      merge: `move:${ids.join()}:${breaks.join()}`,
    });
  };

  const lengthen = (ids: number[], delta: number) => {
    const current = chart();
    const limits = lengthLimits(placeNotes(current, options.length()), new Set(ids), gridStep(current));
    if (!fits(delta, limits)) return;
    options.doc().edit(`Change length of ${count(ids.length)}`, (tx) => resizeNotes(tx, current, ids, delta), {
      merge: `length:${ids.join()}`,
    });
  };

  const repitch = (ids: number[], semitones: number) => {
    if (!pitchFits(chart(), new Set(ids), semitones)) return;
    const first = options.notes().find((note) => note.id === ids[0]);
    if (first) options.onPitch?.(first.pitch + semitones);
    options.doc().edit(`Change pitch of ${count(ids.length)}`, (tx) => shiftPitch(tx, ids, semitones), {
      merge: `pitch:${ids.join()}`,
    });
  };

  /** Selects the next (or previous) note; false when there is none (Tab then moves focus on as usual). */
  const step = (direction: 1 | -1): boolean => {
    const next = adjacentNote(options.notes(), selected(), direction, options.playheadTime());
    if (!next) return false;
    anchor = next.id;
    singers.choose(next.singer);
    select([next.id]);
    options.onReveal(next);
    return true;
  };

  /**
   * The singer new notes go to: the active one, which pressing a note makes its singer (so a double-click, whose first
   * click deselects, still adds to it).
   */
  const singerFor = (): number | null => singers.id();

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
        selectionAfter: () => notesOnly(id === null ? [] : [id]),
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
      `Split ${count(fitting.length)}`,
      (tx) => {
        for (const note of fitting) {
          const second = splitNote(tx, current, note.id, time);
          if (second !== null) seconds.push(second);
        }
      },
      { selectionAfter: () => notesOnly([...fitting.map((note) => note.id), ...seconds]) },
    );
    setCut(null);
    return true;
  };

  /** What the keys and the note menu do to the selection (the menu asks first whether each can). */
  const commands = {
    /** Splits the selected notes the playhead is in, or any it is in with nothing selected. */
    splitAtPlayhead() {
      if (!split(playheadNotes(), options.playheadTime()))
        options.onRefused("Put the playhead inside a note, a step or more from its ends, to split it.");
    },
    canSplitAtPlayhead: () => playheadNotes().some((note) => canSplit(chart(), note, options.playheadTime())),
    merge() {
      const ids = selected();
      let merged: number | null = null;
      options.doc().edit(`Merge ${count(ids.length)}`, (tx) => (merged = mergeNotes(tx, chart(), new Set(ids))), {
        selectionAfter: () => notesOnly(merged === null ? ids : [merged]),
      });
      if (merged === null) options.onRefused("Select notes next to each other in one line to merge them.");
    },
    canMerge: () => canMerge(chart(), new Set(selected())),
    /** In a duet: which singers (indexes) sing the selected notes (none selected: empty). */
    sungBy(): number[] {
      const ids = new Set(selected());
      return chart()
        .singers.filter((singer) => singer.lines.some((line) => line.notes.some((note) => ids.has(note.id))))
        .map((singer) => singer.index);
    },
    /**
     * Sung by: the selected notes go to the singer with this index (those of the other singer move; the notes keep
     * their times), and the singer becomes the active one.
     */
    assign(index: number) {
      const current = chart();
      const to = current.singers.find((singer) => singer.index === index);
      const ids = new Set(selected());
      const from = to && otherSinger(current, to.id);
      const moving = from ? from.lines.flatMap((line) => line.notes).filter((note) => ids.has(note.id)) : [];
      if (!to || moving.length === 0) return;
      const kept = [...ids].filter((id) => !moving.some((note) => note.id === id));
      // Empty when no edit ran (the document stopped after a failed save).
      const done: { result?: ReturnType<typeof transferNotes> } = {};
      options
        .doc()
        .edit(
          `Move ${count(moving.length)} to ${singerLabel(to)}`,
          (tx) => (done.result = transferNotes(tx, current, new Set(moving.map((note) => note.id)), { copy: false })),
          {
            selectionAfter: () =>
              notesOnly(done.result && "ids" in done.result ? [...kept, ...done.result.ids] : [...ids]),
          },
        );
      if (done.result && "refused" in done.result) options.onRefused(done.result.refused);
      else if (done.result) singers.choose(to.index);
    },
    /** The singer Copy to would copy the selected notes to: the other one of a duet, if they are one singer's. */
    copyTarget() {
      const current = chart();
      const from = singerOf(current, new Set(selected()));
      return from ? otherSinger(current, from.id) : null;
    },
    /** Copies the selected notes to the other singer, for both to sing them (independent copies, as the file has). */
    copyToOther() {
      const ids = selected();
      const to = commands.copyTarget();
      if (ids.length === 0 || !to) return;
      const current = chart();
      const done: { result?: ReturnType<typeof transferNotes> } = {};
      options
        .doc()
        .edit(
          `Copy ${count(ids.length)} to ${singerLabel(to)}`,
          (tx) => (done.result = transferNotes(tx, current, new Set(ids), { copy: true })),
          { selectionAfter: () => notesOnly(done.result && "ids" in done.result ? done.result.ids : ids) },
        );
      if (done.result && "refused" in done.result) options.onRefused(done.result.refused);
      else if (done.result) singers.choose(to.index);
    },
    autoPitch() {
      const ids = selected();
      if (ids.length) options.onAutoPitch?.(ids);
    },
    toggleFlag(flag: NoteFlag) {
      const ids = selected();
      const label = NOTE_FLAGS.find((item) => item.flag === flag)!.label;
      options.doc().edit(`${label} ${count(ids.length)}`, (tx) => toggleFlag(tx, chart(), new Set(ids), flag));
    },
    /** Whether all the selected notes have `flag` (the menu ticks it). */
    flagOn(flag: NoteFlag) {
      const ids = new Set(selected());
      const notes = options.notes().filter((note) => ids.has(note.id));
      return notes.length > 0 && notes.every((note) => hasFlag(note.type, flag));
    },
    /** Every note and line break. */
    selectAll() {
      select(
        options.notes().map((note) => note.id),
        options.breaks().map((item) => item.lineId),
      );
    },
    /** Deletes the selected notes and line breaks (`breaks`: these instead). */
    remove(label = "Delete", breaks = selectedBreaks()) {
      const ids = selected();
      options
        .doc()
        .edit(
          `${label} ${things(ids.length, breaks.length)}`,
          (tx) => deleteSelection(tx, chart(), new Set(ids), new Set(breaks)),
          { selection: NOTHING },
        );
    },
  };
  /** The notes the playhead is in: the selected ones, or any with nothing selected. */
  const playheadNotes = () => {
    const time = options.playheadTime();
    const ids = selected();
    return notesAt(options.notes(), time).filter((note) => ids.length === 0 || ids.includes(note.id));
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
    if (preview.plan) {
      const plan = preview.plan;
      options.doc().edit(`Move ${things(ids.length, plan.breaks.size)}`, (tx) => {
        moveSelection(tx, current, plan, preview.time);
        shiftPitch(tx, ids, preview.pitch);
      });
    } else if (preview.part === "start") {
      options.doc().edit(`Change start of ${count(ids.length)}`, (tx) => resizeStarts(tx, current, ids, preview.time));
    } else {
      options.doc().edit(`Change length of ${count(ids.length)}`, (tx) => resizeNotes(tx, current, ids, preview.time));
    }
  };

  /** Follows a press on `note` until it is let go: a drag, or a click that selects just the note. */
  const follow = (
    note: DrawnNote,
    press: PointerPress,
    part: NotePart,
    scale: RollScale,
    selection: Selection,
    justThis: boolean,
  ) => {
    const current = chart();
    const ids = new Set(selection.notes);
    if (!ids.has(note.id)) return;
    // Only a move takes the selected breaks along.
    const plan = part === "body" ? planMove(current, options.length(), ids, new Set(selection.breaks)) : null;
    const unit = gridStep(current);
    const placed = placeNotes(current, options.length());
    const time = plan
      ? plan.limits
      : part === "start"
        ? startLimits(placed, ids, unit)
        : lengthLimits(placed, ids, unit);
    const pitch = pitchLimits(current, ids);
    /** Where the press was, as a pitch in the roll as it was drawn then. */
    const pressPitch = scale.pitchAt?.(press.clientY);
    /**
     * Held past the top or bottom: which way, and the pressed note's pitch there (a semitone further each step; the
     * rows grow to it). Going by the pointer instead would run away: the rows grow, the same spot is a further pitch.
     */
    let edge: { way: 1 | -1; pitch: number; timer: ReturnType<typeof setInterval> } | null = null;
    const leaveEdge = () => {
      if (edge) clearInterval(edge.timer);
      edge = null;
    };
    /** How far the pointer has moved in pitch, by the rows as drawn now (null: no rows given, go by px). */
    const pitchMoved = (clientY: number): number | null => {
      if (pressPitch === undefined || !scale.pitchAt) return null;
      const at = scale.pitchAt(clientY);
      const rows = scale.rows?.();
      const way = !rows ? 0 : at > rows.high + 0.5 ? 1 : at < rows.low - 0.5 ? -1 : 0;
      if (way === 0) {
        leaveEdge();
        return at - pressPitch;
      }
      if (edge?.way !== way) {
        leaveEdge();
        // One past the last row, then on.
        const start = (way === 1 ? rows!.high : rows!.low) + way;
        const timer = setInterval(() => {
          if (edge) edge.pitch += way;
          if (lastMove) onMove(lastMove);
        }, EDGE_STEP_MS);
        edge = { way, pitch: start, timer };
      }
      return edge.pitch - note.pitch;
    };
    /** With Shift, the way the drag went first: only that changes. */
    let locked: "time" | "pitch" | null = null;
    /** The preview as last set (the signal is written on the next microtask; a release can come first). */
    let latest: DragPreview | null = null;
    /** The last move, for the steps past the roll's edge. */
    let lastMove: DragMove | null = null;

    const onMove = (move: DragMove) => {
      lastMove = move;
      const { dx, dy, scrolled, event } = move;
      if (event.shiftKey && part === "body") locked ??= Math.abs(dx) >= Math.abs(dy) ? "time" : "pitch";
      else locked = null;
      const seconds = locked === "pitch" ? 0 : snapDelta(dx / scale.pxPerSecond + scrolled, unit, time);
      // Locked to time, the pitch doesn't change: nothing to step past the roll's edge for.
      if (locked === "time") leaveEdge();
      const semitones =
        part !== "body" || locked === "time"
          ? 0
          : snapDelta(pitchMoved(event.clientY) ?? -dy / scale.rowHeight, 1, pitch);
      const steps = Math.round(seconds / unit);
      const label =
        part === "body"
          ? [stepsLabel(steps), pitchName(note.pitch + semitones)].filter(Boolean).join(" · ")
          : stepsLabel(steps) || "±0";
      if (semitones !== (latest?.pitch ?? 0)) options.onPitch?.(note.pitch + semitones);
      latest = { ids, plan, part, time: seconds, pitch: semitones, anchor: { note: note.id }, label };
      setDrag(latest);
    };
    setActive(true);
    cancelDrag = followDrag({
      press,
      target: options.pointerTarget ?? window,
      threshold: "xy",
      autoScroll: options.autoScroll,
      viewStart: options.viewStart,
      onMove,
      onStop: () => {
        leaveEdge();
        cancelDrag = null;
        setActive(false);
        setDrag(null);
      },
      onUp: (dragged) => {
        if (latest && (latest.time !== 0 || latest.pitch !== 0)) commitDrag(latest);
        else if (!dragged && justThis) select([note.id]);
      },
    });
  };

  /** Follows a press on a selected break's marker: a drag moves the whole selection in time, a click selects just it. */
  const followTime = (item: LineBreak, press: PointerPress, pxPerSecond: number, selection: Selection) => {
    const current = chart();
    const ids = new Set(selection.notes);
    const plan = planMove(current, options.length(), ids, new Set(selection.breaks));
    const unit = gridStep(current);
    /** The preview as last set (the signal is written on the next microtask; a release can come first). */
    let latest: DragPreview | null = null;
    setActive(true);
    cancelDrag = followDrag({
      press,
      target: options.pointerTarget ?? window,
      threshold: "x",
      autoScroll: options.autoScroll,
      viewStart: options.viewStart,
      onMove: ({ dx, scrolled }) => {
        const time = snapDelta(dx / pxPerSecond + scrolled, unit, plan.limits);
        const label = stepsLabel(Math.round(time / unit)) || "±0";
        latest = { ids, plan, part: "body", time, pitch: 0, anchor: { lineBreak: item.lineId }, label };
        setDrag(latest);
      },
      onStop: () => {
        cancelDrag = null;
        setActive(false);
        setDrag(null);
      },
      onUp: (dragged) => {
        if (latest && latest.time !== 0) commitDrag(latest);
        else if (!dragged) options.setSelection(breaksOnly([item.lineId]));
      },
    });
  };

  return {
    /** The drag in progress, if any. */
    drag,
    /** The singer (id) new notes and line breaks go to: the one whose note was touched last, else the first. */
    activeSinger: () => singerFor(),
    /** Whether a drag or a drawing is in progress (Esc stops it before anything else). */
    busy: () => {
      active();
      return cancelDrag !== null;
    },
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
      /** The note as last drawn (the signal is written on the next microtask; a release can come first). */
      let drawn: { start: number; duration: number; pitch: number } | null = null;
      options.onPitch?.(at.pitch);
      setActive(true);
      cancelDrag = followDrag({
        press,
        target: options.pointerTarget ?? window,
        threshold: "x",
        autoScroll: options.autoScroll,
        viewStart: options.viewStart,
        onMove: ({ dx, scrolled }) => {
          const end = Math.min(options.length(), onGrid(current, at.time + dx / scale.pxPerSecond + scrolled));
          drawn = { start, duration: Math.max(unit, end - start), pitch: at.pitch };
          setDrawing(drawn);
        },
        onStop: () => {
          cancelDrag = null;
          setActive(false);
          setDrawing(null);
        },
        onUp: (dragged) => {
          if (drawn) {
            lastLength = drawn.duration;
            add(drawn.start, drawn.duration, drawn.pitch);
          } else if (!dragged) add(start, clickLength(), at.pitch);
        },
      });
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
      singers.choose(note.singer);
      const targets = every ? notesAt(options.notes(), time) : [note];
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
      singers.choose(note.singer);
      const breaks = selectedBreaks();
      if (press.metaKey || press.ctrlKey) {
        anchor = note.id;
        select(toggled(selected(), note.id), breaks);
        return;
      }
      // The selection is written on the next microtask; the drag goes on with what it becomes.
      let next: Selection = { notes: selected(), breaks };
      if (press.shiftKey && anchor !== null) {
        next = { ...next, notes: [...new Set([...next.notes, ...rangeSelection(options.notes(), anchor, note.id)])] };
      } else {
        anchor = note.id;
        lastLength = note.duration;
        if (!next.notes.includes(note.id)) next = notesOnly([note.id]);
      }
      select(next.notes, next.breaks);
      const justThis = !press.shiftKey && next.notes.length + next.breaks.length > 1;
      if (scale) follow(note, press, part, scale, next, justThis);
    },

    /**
     * A press on a line break (its marker, or its line in the roll): Shift adds it to the selection, Cmd/Ctrl adds it
     * or takes it out. On a selected break with more selected, a drag moves all of it in time and a click selects just
     * the break; otherwise it is selected alone and dragged on its own (`oneBreak`).
     */
    breakDown(item: LineBreak, press: PointerPress, pxPerSecond: number) {
      cancelDrag?.();
      singers.choose(item.singer);
      const ids = selected();
      const breaks = selectedBreaks();
      if (press.metaKey || press.ctrlKey) select(ids, toggled(breaks, item.lineId));
      else if (press.shiftKey) select(ids, [...new Set([...breaks, item.lineId])]);
      else if (breaks.includes(item.lineId) && ids.length + breaks.length > 1) {
        followTime(item, press, pxPerSecond, { notes: ids, breaks });
      } else {
        options.setSelection(breaksOnly([item.lineId]));
        options.oneBreak?.follow(item, press, pxPerSecond);
      }
    },

    /** The selection being dragged by one of its break markers: where that break would go, and the drag's label. */
    markerDrag(): { lineId: number; time: number; label: string } | null {
      const moving = drag();
      if (!moving?.plan || !("lineBreak" in moving.anchor)) return null;
      const lineId = moving.anchor.lineBreak;
      const moved = moving.plan.breakAt(lineId, moving.time);
      return moved && { lineId, time: moved.time, label: moving.label };
    },

    /**
     * Copies the selected notes; returns the text for the system clipboard, null when nothing is selected (a copy
     * elsewhere can go on), or false when it can't copy them (it said why; nothing else should copy).
     */
    copySelection(): string | null | false {
      const breaks = copy();
      return breaks ? clip!.text : breaks;
    },

    /** Copies the selected notes and deletes them, with the breaks the copy took (others selected stay). */
    cutSelection(): string | null | false {
      const breaks = copy();
      if (!breaks) return breaks;
      commands.remove("Cut", breaks);
      return clip!.text;
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
        .edit(`Paste ${count(pasted.notes.length)}`, (tx) => (ids = pasteNotes(tx, chart(), pasted, target)), {
          selectionAfter: () => notesOnly(ids),
        });
      if (ids.length === 0) options.onRefused("There's no room to paste here: it would be past the song's end.");
      return true;
    },

    /**
     * The pitches auto pitch found, as one edit: only for notes still where they were when it was asked (`asked`, by
     * id: start and length), since it worked from their timing.
     */
    applyPitches(
      pitches: readonly { id: number; pitch: number }[],
      asked: ReadonlyMap<number, { start: number; duration: number; pitch: number }>,
    ): number {
      // Every singer's notes: one hidden meanwhile still gets its pitch.
      const now = new Map(drawnNotes(options.doc().chart()).map((note) => [note.id, note]));
      const dragged = drag()?.ids;
      // Notes moved, resized or repitched meanwhile (or being dragged) are the user's now: they stay as they are.
      const changed = pitches.filter(({ id, pitch }) => {
        const note = now.get(id);
        const before = asked.get(id);
        return (
          note &&
          before &&
          !dragged?.has(id) &&
          note.start === before.start &&
          note.duration === before.duration &&
          note.pitch === before.pitch &&
          note.pitch !== pitch
        );
      });
      options.doc().edit(`Auto pitch ${count(changed.length)}`, (tx) => {
        for (const { id, pitch } of changed) tx.updateNote(id, { pitch });
      });
      return changed.length;
    },

    /** The keys' and the note menu's actions on the selection. */
    commands,

    /** A right-click on a note: the menu is for the selection, which it joins unless it is in it already. */
    menuOpen(note: DrawnNote) {
      cancelDrag?.();
      singers.choose(note.singer);
      if (selected().includes(note.id)) return;
      anchor = note.id;
      select([note.id]);
    },

    /** A click on empty space: nothing selected any more. */
    emptyClick() {
      select([]);
    },

    /** A selection box: the notes it touches and the line breaks it crosses, or those added to the selection. */
    box(area: { from: number; to: number; low: number; high: number }, add: boolean) {
      const notes = notesInBox(options.notes(), area);
      const singers = new Set(
        options
          .notes()
          .filter((note) => notes.includes(note.id))
          .map((note) => note.singer),
      );
      const breaks = breaksInBox(options.breaks(), area, singers);
      if (add) select([...new Set([...selected(), ...notes])], [...new Set([...selectedBreaks(), ...breaks])]);
      else select(notes, breaks);
    },

    /** Handles a key for the selection; returns whether it did (so the caller prevents the default). */
    key(event: {
      key: string;
      shiftKey: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      repeat?: boolean;
    }): boolean {
      if (cancelDrag) {
        // During a drag only Esc counts: it puts the notes back.
        if (event.key === "Escape") cancelDrag();
        return event.key === "Escape";
      }
      const command = event.metaKey || event.ctrlKey;
      if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
        commands.selectAll();
        return true;
      }
      if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        commands.splitAtPlayhead();
        return true;
      }
      if (command || event.altKey) return false;
      if (event.key === "Tab") return step(event.shiftKey ? -1 : 1);
      const ids = selected();
      const breaks = selectedBreaks();
      if (ids.length === 0 && breaks.length === 0) return false;
      if (event.key === "Escape") {
        select([]);
        return true;
      }
      switch (event.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          const direction = event.key === "ArrowRight" ? 1 : -1;
          // Just a break: on its own, over notes too.
          if (ids.length === 0 && breaks.length === 1) {
            if (!event.shiftKey) options.oneBreak?.nudge(breaks[0]!, direction);
          } else if (!event.shiftKey) nudge(ids, breaks, direction * gridStep(chart()));
          else if (ids.length > 0) lengthen(ids, direction * gridStep(chart()));
          return true;
        }
        case "Delete":
        case "Backspace":
          commands.remove();
          return true;
      }
      // The rest is for notes.
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
      }
      const key = event.key.toLowerCase();
      if (event.shiftKey) return false;
      if (key === "m") commands.merge();
      // Held down, A doesn't start it again each time a run ends.
      else if (key === "a") {
        if (!event.repeat) commands.autoPitch();
      } else if (flagFor(key)) commands.toggleFlag(flagFor(key)!);
      else return false;
      return true;
    },
  };
}
