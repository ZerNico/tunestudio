/**
 * Looping a stretch of the song. The range is marked on the time ruler: a click there still moves the playhead, a drag
 * marks a range (on the grid) and turns looping on; a range's edges are dragged to change it, a double-click removes
 * it. L (or the transport's button) turns looping on and off; with notes selected, turning it on loops them. While
 * looping, playing starts at the range when the playhead is outside it, and goes back to its start at its end.
 */
import { createSignal } from "solid-js";

import { DRAG_PX } from "./drag";

export interface LoopRange {
  start: number;
  end: number;
}

/** The shortest range (seconds): shorter drags are clicks. */
const MIN_SECONDS = 0.05;

/** Where playing starts while looping: the range's start when `time` is outside it. */
export function loopStart(time: number, range: LoopRange): number {
  return time < range.start || time >= range.end ? range.start : time;
}

/** Where to go on a frame while looping: back to the start once `time` reaches the end, else null. */
export function loopBack(time: number, range: LoopRange): number | null {
  return time >= range.end ? range.start : null;
}

export function createLoop(options: {
  /** Puts a time on the grid. */
  snap: (seconds: number) => number;
  /** The song's length (seconds). */
  length: () => number;
  /** A click on the ruler: the playhead goes there. */
  onSeek: (seconds: number) => void;
}) {
  const [range, setRange] = createSignal<LoopRange | null>(null);
  const [on, setOn] = createSignal(false);
  /** The range as a drag in progress has it. */
  const [draft, setDraft] = createSignal<LoopRange | null>(null);
  let gesture: { fixed: number; at: number; x: number; moved: boolean } | null = null;

  /** A time on the grid and inside the song. */
  const clamp = (seconds: number) => Math.min(options.length(), Math.max(0, options.snap(seconds)));
  /** The range between two times, on the grid and inside the song (null: too short). */
  const between = (a: number, b: number): LoopRange | null => {
    const start = clamp(Math.min(a, b));
    const end = clamp(Math.max(a, b));
    return end - start >= MIN_SECONDS ? { start, end } : null;
  };
  const active = () => (on() ? range() : null);

  return {
    /** The range (as a drag has it while there is one). */
    range: () => draft() ?? range(),
    on,
    /** A drag on the ruler is in progress. */
    busy: () => gesture !== null,

    /**
     * L: looping off, or on (with notes selected, over them). Returns false when there is nothing to loop.
     * `selection`: the selected notes' span, if any.
     */
    toggle(selection: LoopRange | null): boolean {
      if (on()) {
        setOn(false);
        return true;
      }
      const next = selection ? between(selection.start, selection.end) : range();
      if (!next) return false;
      setRange(next);
      setOn(true);
      return true;
    },
    /** A double-click on the ruler at `time` (or on the playhead's head there): removes the range it is in. */
    clearAt(time: number) {
      const current = range();
      if (current && time >= current.start && time <= current.end) {
        setRange(null);
        setOn(false);
      }
    },

    /** A press on the ruler at `time` (`x` px), on one of the range's edges or not. */
    down(time: number, x: number, edge: "start" | "end" | null) {
      const current = range();
      if (edge && current) {
        // An edge moves; the other stays.
        gesture = { fixed: edge === "start" ? current.end : current.start, at: time, x, moved: true };
        setDraft(current);
      } else gesture = { fixed: time, at: time, x, moved: false };
    },
    move(time: number, x: number) {
      if (!gesture) return;
      gesture.at = time;
      if (!gesture.moved && Math.abs(x - gesture.x) < DRAG_PX) return;
      gesture.moved = true;
      setDraft(between(gesture.fixed, time));
    },
    up() {
      if (!gesture) return;
      const done = gesture;
      gesture = null;
      const next = draft();
      setDraft(null);
      if (!done.moved) {
        options.onSeek(done.at);
        return;
      }
      // A new range loops at once; an edge too short to keep leaves the range as it was.
      if (next) {
        setRange(next);
        setOn(true);
      }
    },
    cancel() {
      gesture = null;
      setDraft(null);
    },

    /** Where playing starts. */
    startAt(time: number): number {
      const current = active();
      return current ? loopStart(time, current) : time;
    },
    /** On a frame while playing: the time to go back to, or null. */
    back(time: number): number | null {
      const current = active();
      return current ? loopBack(time, current) : null;
    },
  };
}

export type Loop = ReturnType<typeof createLoop>;
