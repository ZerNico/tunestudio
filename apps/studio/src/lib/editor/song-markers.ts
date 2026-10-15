/**
 * The song's times as markers on the timeline: where the game starts and stops playing (`#START`, `#END`; handles at
 * the ruler's ends, the rest dimmed), where the song list's preview plays from (a flag on the ruler), and the medley
 * excerpt (a band in the overview bar, from a line's start to a line's end, as UltraStar counts it). A marker is
 * dragged (shown where it would go) and written as one edit when let go; start and end stay in order and inside the
 * song, and so do the medley's.
 */
import { createSignal } from "solid-js";

import type { SongFields } from "~/lib/native/contract";
import type { EditorSong } from "~/lib/native/types";

import type { LineSpan } from "./chart";

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
  if (lines.length === 0) return null;
  return {
    start: Math.min(...lines.map((line) => line.start)),
    end: Math.max(...lines.map((line) => line.start + line.duration)),
  };
}

export function createSongMarkers(options: {
  song: () => EditorSong;
  /** The song's length (seconds). */
  length: () => number;
  /** Puts a time on the grid. */
  snap: (seconds: number) => number;
  /** The lines the medley snaps to (the first singer's). */
  lines: () => readonly LineSpan[];
  /** Writes a change as an edit called `label`. */
  onChange: (label: string, patch: SongFields) => void;
}) {
  const [draft, setDraft] = createSignal<{ marker: SongMarker; time: number } | null>(null);
  /** The marker being dragged, and where it is now (kept here too: a release can come before the signal is written). */
  let dragging: { marker: SongMarker; time: number } | null = null;

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

  return {
    /** Where a marker is (as a drag has it), or null when it isn't set. */
    at(marker: SongMarker): number | null {
      const current = draft();
      return current?.marker === marker ? current.time : options.song()[FIELDS[marker]];
    },
    /** A marker is being dragged. */
    busy: () => dragging !== null,
    down(marker: SongMarker) {
      dragging = { marker, time: options.song()[FIELDS[marker]] ?? (marker === "end" ? options.length() : 0) };
    },
    move(time: number) {
      if (!dragging) return;
      dragging = { marker: dragging.marker, time: place(dragging.marker, time) };
      setDraft(dragging);
    },
    up() {
      const done = dragging;
      dragging = null;
      setDraft(null);
      if (!done) return;
      const value = stored(done.marker, done.time);
      if (value !== options.song()[FIELDS[done.marker]])
        options.onChange(LABELS[done.marker], { [FIELDS[done.marker]]: value });
    },
    cancel() {
      dragging = null;
      setDraft(null);
    },

    /** Puts a marker at `time` (or as near as it may go), as an edit. */
    set(marker: SongMarker, time: number) {
      const value = stored(marker, place(marker, time));
      if (value !== options.song()[FIELDS[marker]]) options.onChange(LABELS[marker], { [FIELDS[marker]]: value });
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
