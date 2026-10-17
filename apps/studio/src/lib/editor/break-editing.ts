/**
 * Editing one line break (`breaks.ts` has the rules): dragging it, or ← / → with just it selected, moves it, across
 * notes too (they change line). A drag is a preview (`drag`, with a label) until it is let go, then one edit; Esc
 * cancels. A double-click on a marker removes it, one on the lane adds a break there (stored at that time). B (and Add
 * line break) adds one with default timing after the selected notes (their singer becomes the active one), or with
 * none selected in the gap nearest the playhead, for the active singer. A double-click adds to whichever shown singer
 * has a line there, the active one first. What a press selects, and moving or deleting a selection, is
 * `note-editing.ts`'s.
 */

import { createSignal } from "solid-js";

import type { AutoScroll } from "./autoscroll";
import {
  addBreak,
  breakAfter,
  breakLanding,
  breakRange,
  linesAround,
  moveBreak,
  nearestGap,
  removeBreak,
  stepBreak,
} from "./breaks";
import { type LineBreak, lineBreaks } from "./chart";
import type { ChartDocument } from "./document";
import { followDrag } from "./drag";
import type { Selection } from "./selection";
import { formatTime } from "./view";

/** A break being dragged: where it would go, and what to say about it. */
export interface BreakDrag {
  lineId: number;
  time: number;
  label: string;
}

export function createBreakEditing(options: {
  doc: () => ChartDocument<Selection>;
  selection: () => Selection;
  setSelection: (selection: Selection) => void;
  /** The singer (id) new breaks go to. */
  singer: () => number | null;
  /** In a duet: the singers (ids) a double-click on the lane may add a break for, the active one first. */
  singers?: () => number[];
  /** A double-click or Line break after added a break for this singer (id): it becomes the active one. */
  onSinger?: (singerId: number) => void;
  playheadTime: () => number;
  /** Whether another gesture is under way (a note drag, a selection box): B waits for it. */
  busy?: () => boolean;
  onRefused: (message: string) => void;
  /** Where pointer moves and releases are heard during a drag (the window; tests pass their own). */
  pointerTarget?: EventTarget;
  /** Scrolls the view while a drag is at the roll's edge (`autoscroll.ts`). */
  autoScroll?: AutoScroll;
  /** Where the view starts (seconds): a drag counts how far it scrolled. */
  viewStart?: () => number;
}) {
  const [drag, setDrag] = createSignal<BreakDrag | null>(null);
  let cancelDrag: (() => void) | null = null;
  const [active, setActive] = createSignal(false);
  const chart = () => options.doc().chart();

  /**
   * The selection after the break ending `from` now ends `to` (adding and removing breaks moves them between lines),
   * without the one ending `gone`.
   */
  const renamed = (from: number, to: number, gone: number | null): Selection => {
    const { notes, breaks } = options.selection();
    return { notes, breaks: breaks.flatMap((id) => (id === gone ? [] : id === from ? [to] : [id])) };
  };

  const remove = (lineId: number) => {
    const current = chart();
    let next: number | null = null;
    options.doc().edit("Remove line break", (tx) => void (next = removeBreak(tx, current, lineId)), {
      selectionAfter: () => (next === null ? options.selection() : renamed(next, lineId, lineId)),
    });
  };

  /** A break at `time` (stored there, or with `automatic` default timing). */
  const add = (time: number, automatic = false) => {
    const active = options.singer();
    const candidates = options.singers?.() ?? (active === null ? [] : [active]);
    const current = chart();
    let added: ReturnType<typeof addBreak> = null;
    let singerId: number | null = null;
    if (candidates.length > 0) {
      options.doc().edit(
        "Add line break",
        (tx) => {
          // addBreak changes nothing when the singer has no line to split there.
          for (const candidate of candidates) {
            added = addBreak(tx, current, candidate, time, automatic);
            if (added) {
              singerId = candidate;
              break;
            }
          }
        },
        { selectionAfter: () => (added ? renamed(added.split, added.created, null) : options.selection()) },
      );
    }
    if (!added) options.onRefused("Put the line break between two notes of a line.");
    else if (singerId !== null && singerId !== active) options.onSinger?.(singerId);
  };

  /** A break with default timing after the selected notes. */
  const addAfter = () => {
    const current = chart();
    const ids = new Set(options.selection().notes);
    // Set inside the edit (a cast, so TypeScript doesn't narrow it to the empty string).
    let result = "" as ReturnType<typeof breakAfter>;
    options.doc().edit("Add line break", (tx) => void (result = breakAfter(tx, current, ids)), {
      selectionAfter: () =>
        typeof result === "string" ? options.selection() : renamed(result.split, result.created, null),
    });
    if (typeof result === "string") options.onRefused(result);
    else if (result.singerId !== options.singer()) options.onSinger?.(result.singerId);
  };

  /** B: after the selected notes, or with none in the gap nearest the playhead, with default timing. */
  const addHere = () => {
    const notes = new Set(
      chart()
        .singers.flatMap((singer) => singer.lines.flatMap((line) => line.notes))
        .map((note) => note.id),
    );
    if (options.selection().notes.some((id) => notes.has(id))) return addAfter();
    const singerId = options.singer();
    const at = singerId === null ? null : nearestGap(chart(), singerId, options.playheadTime());
    if (typeof at === "number") add(at, true);
    else options.onRefused(at ?? "There's no gap between notes here for a line break.");
  };

  /** How many notes a break at `time` moves to the other line. */
  const moved = (lineId: number, time: number) => {
    const around = linesAround(chart(), lineId);
    const line = around?.lines[around.index];
    const next = around?.lines[around.index + 1];
    if (!line || !next) return 0;
    return (
      line.notes.filter((note) => note.start >= time).length + next.notes.filter((note) => note.start < time).length
    );
  };

  return {
    drag,
    /** Whether a break is being dragged (Esc stops it before anything else). */
    busy: () => {
      active();
      return cancelDrag !== null;
    },
    /** Stops a drag without changing anything (before undo and redo, and when the editor goes away). */
    cancel: () => cancelDrag?.(),

    /** Follows a press on a marker (selected by `note-editing.ts`) for a drag of just that break. */
    follow(item: LineBreak, press: { clientX: number }, pxPerSecond: number) {
      cancelDrag?.();
      const current = chart();
      const range = breakRange(current, item.lineId);
      if (!range) return;
      /** The drag as last shown (the signal is written on the next microtask; a release can come first). */
      let latest: BreakDrag | null = null;
      setActive(true);
      cancelDrag = followDrag({
        press: { clientX: press.clientX, clientY: 0 },
        target: options.pointerTarget ?? window,
        threshold: "x",
        autoScroll: options.autoScroll,
        viewStart: options.viewStart,
        onMove: ({ dx, scrolled }) => {
          // Only where it may go: on the grid, never inside a note.
          const time = breakLanding(current, item.lineId, item.time + dx / pxPerSecond + scrolled) ?? item.time;
          const count = moved(item.lineId, time);
          const label = [formatTime(time), count === 0 ? "" : `${count} ${count === 1 ? "note moves" : "notes move"}`]
            .filter(Boolean)
            .join(" · ");
          latest = { lineId: item.lineId, time, label };
          setDrag(latest);
        },
        onStop: () => {
          cancelDrag = null;
          setActive(false);
          setDrag(null);
        },
        onUp: () => {
          const preview = latest;
          if (preview) {
            options.doc().edit("Move line break", (tx) => void moveBreak(tx, current, preview.lineId, preview.time));
          }
        },
      });
    },

    /** ← / → with just a break selected: it goes a grid step, over notes too (they change line). */
    nudge(lineId: number, direction: 1 | -1) {
      const current = chart();
      const item = lineBreaks(current).find((each) => each.lineId === lineId);
      const time = item && stepBreak(current, lineId, item.time, direction);
      if (time === null || time === undefined) return;
      options
        .doc()
        .edit("Move line break", (tx) => void moveBreak(tx, current, lineId, time), { merge: `break:${lineId}` });
    },

    /** A double-click on a marker removes it. */
    breakDoubleClick(item: LineBreak) {
      remove(item.lineId);
    },

    /** Reset timing (a marker's menu): the break follows the default rule again, as the gap around it changes. */
    resetTiming(item: LineBreak) {
      if (item.auto) return;
      options
        .doc()
        .edit("Reset line break timing", (tx) => tx.updateLine(item.lineId, { switchStart: null, switchEnd: null }));
    },

    /** Line break after (the note menu): a break with default timing after the selected notes. */
    addAfter,
    /** Add line break (B and the title bar): after the selected notes, or at the playhead. */
    addHere,

    /** A double-click on the lane adds a break there. */
    laneDoubleClick(time: number) {
      add(time);
    },

    /** Handles a key; returns whether it did. */
    key(event: {
      key: string;
      shiftKey: boolean;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      repeat?: boolean;
    }): boolean {
      if (cancelDrag) {
        if (event.key === "Escape") cancelDrag();
        return event.key === "Escape";
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      if (event.key.toLowerCase() === "b" && !event.shiftKey) {
        // Held, it adds one break, not one per repeat.
        if (!event.repeat && !options.busy?.()) addHere();
        return true;
      }
      return false;
    },
  };
}
