/**
 * The song's times as markers on the timeline: where the game starts and stops playing (`#START`, `#END`; handles at
 * the ruler's ends, the rest dimmed), where the song list's preview plays from (a flag on the ruler), and the medley
 * excerpt (a band in the overview bar, from a line's start to a line's end, as UltraStar counts it). A marker is
 * dragged (shown where it would go) and written as one edit when let go; a press that doesn't move is a click, which
 * moves the playhead. Start and end stay in order and inside the song, and so do the medley's.
 */
import { createSignal } from "solid-js";

import type { SongFields } from "~/lib/native/contract";
import type { EditorSong } from "~/lib/native/types";

import { type LineSpan, spanOf } from "./chart";
import { DRAG_PX } from "./drag";

export type SongMarker = "start" | "end" | "preview" | "medleyStart" | "medleyEnd";

const FIELDS = {
  start: "start",
  end: "end",
  preview: "previewStart",
  medleyStart: "medleyStart",
  medleyEnd: "medleyEnd",
} as const satisfies Record<SongMarker, keyof EditorSong>;

const LABELS: Record<SongMarker, string> = {
  start: "Move start",
  end: "Move end",
  preview: "Move preview start",
  medleyStart: "Move medley start",
  medleyEnd: "Move medley end",
};

const CLEARED: Record<SongMarker, string> = {
  start: "start",
  end: "end",
  preview: "preview start",
  medleyStart: "medley",
  medleyEnd: "medley",
};

const within = (low: number, high: number, value: number) => Math.min(high, Math.max(low, value));

/** Start and end are at least this far apart (seconds). */
const MIN_PLAYED = 1;

/** The line start (or end) nearest `time`, or null without lines. */
export function nearestLineEdge(lines: readonly LineSpan[], time: number, edge: "start" | "end"): number | null {
  let best: number | null = null;
  for (const line of lines) {
    const at = edge === "start" ? line.start : line.start + line.duration;
    if (best === null || Math.abs(at - time) < Math.abs(best - time)) best = at;
  }
  return best;
}

/** The medley over the lines with selected notes: from the first one's start to the last one's end. */
export function medleyOver(lines: readonly LineSpan[]): { start: number; end: number } | null {
  return spanOf(lines);
}

export function createSongMarkers(options: {
  song: () => EditorSong;
  /** The song's length (seconds). */
  length: () => number;
  /** Puts a time on the grid. */
  snap: (seconds: number) => number;
  /** The lines the medley snaps to (every singer's). */
  lines: () => readonly LineSpan[];
  /** Writes a change as an edit called `label`. */
  onChange: (label: string, patch: SongFields) => void;
  /** A click on a marker (a press that didn't move): the playhead goes there. */
  onSeek?: (seconds: number) => void;
}) {
  const [draft, setDraft] = createSignal<{ marker: SongMarker; time: number } | null>(null);
  /**
   * The marker being dragged, and where it is now (kept here too: a release can come before the signal is written);
   * where the press was, and whether it has moved enough to be a drag.
   */
  let dragging: { marker: SongMarker; time: number; pressed: number; x: number; moved: boolean } | null = null;
  const [active, setActive] = createSignal(false);

  /** Where `marker` may go for `time`, given the others. */
  const place = (marker: SongMarker, time: number): number => {
    const song = options.song();
    const length = options.length();
    switch (marker) {
      case "start":
        return within(0, (song.end ?? length) - MIN_PLAYED, options.snap(time));
      case "end":
        return within((song.start ?? 0) + MIN_PLAYED, length, options.snap(time));
      case "preview":
        return within(0, length, options.snap(time));
      case "medleyStart": {
        const end = song.medleyEnd ?? length;
        const lines = options.lines().filter((line) => line.start < end);
        return nearestLineEdge(lines, time, "start") ?? within(0, end, time);
      }
      case "medleyEnd": {
        const start = song.medleyStart ?? 0;
        const lines = options.lines().filter((line) => line.start + line.duration > start);
        return nearestLineEdge(lines, time, "end") ?? within(start, length, time);
      }
    }
  };

  /** What is stored for a marker at `time`: a start at the song's start or an end at its end is no start or end. */
  const stored = (marker: SongMarker, time: number): number | null => {
    if (marker === "start" && time <= 0) return null;
    if (marker === "end" && time >= options.length()) return null;
    return time;
  };

  /** Writes a marker at `time` (placed already) as an edit, unless it is there already. */
  const write = (marker: SongMarker, time: number) => {
    const value = stored(marker, time);
    if (value !== options.song()[FIELDS[marker]]) options.onChange(LABELS[marker], { [FIELDS[marker]]: value });
  };

  return {
    /** Where a marker is (as a drag has it), or null when it isn't set. */
    at(marker: SongMarker): number | null {
      const current = draft();
      return current?.marker === marker ? current.time : options.song()[FIELDS[marker]];
    },
    /** A marker is being dragged. */
    busy: () => {
      active();
      return dragging !== null;
    },
    /** A press on a marker at `time` (`x` px; for an edge in the overview bar, leave `x` out: it drags at once). */
    down(marker: SongMarker, time?: number, x?: number) {
      const at = options.song()[FIELDS[marker]] ?? (marker === "end" ? options.length() : 0);
      dragging = { marker, time: at, pressed: time ?? at, x: x ?? 0, moved: x === undefined };
      setActive(true);
    },
    move(time: number, x?: number) {
      if (!dragging) return;
      if (!dragging.moved && x !== undefined && Math.abs(x - dragging.x) < DRAG_PX) return;
      dragging = { ...dragging, time: place(dragging.marker, time), moved: true };
      setDraft({ marker: dragging.marker, time: dragging.time });
    },
    up() {
      const done = dragging;
      dragging = null;
      setActive(false);
      setDraft(null);
      if (!done) return;
      if (!done.moved) {
        options.onSeek?.(done.pressed);
        return;
      }
      write(done.marker, done.time);
    },
    cancel() {
      dragging = null;
      setActive(false);
      setDraft(null);
    },

    /** Puts a marker at `time` (or as near as it may go), as an edit. */
    set(marker: SongMarker, time: number) {
      write(marker, place(marker, time));
    },
    /** The medley over these lines (the selected notes'), as one edit. */
    setMedley(lines: readonly LineSpan[]) {
      const medley = medleyOver(lines);
      if (medley) options.onChange("Set medley", { medleyStart: medley.start, medleyEnd: medley.end });
    },
    /** Unsets a marker (the medley's two together), as an edit. */
    clear(marker: SongMarker) {
      const medley = marker === "medleyStart" || marker === "medleyEnd";
      const patch: SongFields = medley ? { medleyStart: null, medleyEnd: null } : { [FIELDS[marker]]: null };
      options.onChange(medley ? "Clear medley" : `Clear ${CLEARED[marker]}`, patch);
    },
  };
}

export type SongMarkers = ReturnType<typeof createSongMarkers>;
