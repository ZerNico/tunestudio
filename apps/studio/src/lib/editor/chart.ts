/**
 * The editor's chart, flattened into what is drawn: notes in time order, each line's span and text, the line breaks;
 * and its grid (a step is 15 / #BPM seconds from #GAP).
 */
import { defaultSwitch } from "@tunestudio/ultrastar";

import type { EditorChart, EditorNote } from "~/lib/native/types";

/** Times closer than this are the same (seconds, against float rounding). */
const EPSILON = 1e-6;

/** One grid step in seconds. */
export const gridStep = (chart: EditorChart) => 15 / chart.bpm;

/** `seconds` on the nearest grid line. */
export function onGrid(chart: EditorChart, seconds: number): number {
  const step = gridStep(chart);
  return chart.gap + Math.round((seconds - chart.gap) / step) * step;
}

/** The highest grid line at or below `seconds`. */
export function gridFloor(chart: EditorChart, seconds: number): number {
  const step = gridStep(chart);
  return chart.gap + Math.floor((seconds - chart.gap) / step + EPSILON) * step;
}

/** The lowest grid line at or above `seconds`. */
export function gridCeil(chart: EditorChart, seconds: number): number {
  const step = gridStep(chart);
  return chart.gap + Math.ceil((seconds - chart.gap) / step - EPSILON) * step;
}

/** A note as drawn: which singer (1 or 2) and line it belongs to. */
export interface DrawnNote extends EditorNote {
  singer: number;
  lineId: number;
}

/** A line as drawn: its time span (first note start to last note end) and its text. */
export interface LineSpan {
  id: number;
  singer: number;
  start: number;
  duration: number;
  text: string;
}

/** Every note of every singer, by start time. */
export function drawnNotes(chart: EditorChart): DrawnNote[] {
  return chart.singers
    .flatMap((singer) =>
      singer.lines.flatMap((line) => line.notes.map((note) => ({ ...note, singer: singer.index, lineId: line.id }))),
    )
    .toSorted((a, b) => a.start - b.start);
}

/** A line's text as sung: its syllables joined, without the `~` that marks a held vowel. */
export function lineText(notes: readonly EditorNote[]): string {
  return notes
    .map((note) => note.lyric.replaceAll("~", ""))
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/** Every line with notes, by start time. */
export function lineSpans(chart: EditorChart): LineSpan[] {
  return chart.singers
    .flatMap((singer) =>
      singer.lines
        .filter((line) => line.notes.length > 0)
        .map((line) => {
          const first = line.notes[0]!;
          const last = line.notes.at(-1)!;
          return {
            id: line.id,
            singer: singer.index,
            start: first.start,
            duration: last.start + last.duration - first.start,
            text: lineText(line.notes),
          };
        }),
    )
    .toSorted((a, b) => a.start - b.start);
}

/**
 * A line break: the moment the game shows a singer's next line, between the last note of `lineId` and the first note
 * of the line after it. Everything between two breaks is one line.
 */
export interface LineBreak {
  /** The line it ends. */
  lineId: number;
  singer: number;
  time: number;
  /** No switch time is stored: this is the default. */
  auto: boolean;
  /** The gap it can sit in: the end of the line's last note to the start of the next line's first. */
  gapStart: number;
  gapEnd: number;
}

/** Each singer's non-empty lines, in order. */
function linesBySinger(chart: EditorChart) {
  return chart.singers.map((singer) => ({
    singer: singer.index,
    lines: singer.lines.filter((line) => line.notes.length > 0),
  }));
}

/** Every line break of every singer, by time; a stored switch outside its gap is drawn at the gap's edge. */
export function lineBreaks(chart: EditorChart): LineBreak[] {
  return linesBySinger(chart)
    .flatMap(({ singer, lines }) =>
      lines.slice(0, -1).map((line, i) => {
        // The latest end, as the file's break is worked out (an earlier long note can outlast the last one).
        const gapStart = Math.max(...line.notes.map((note) => note.start + note.duration));
        const gapEnd = Math.max(gapStart, lines[i + 1]!.notes[0]!.start);
        const stored = line.switchStart;
        const time = stored ?? defaultSwitch(gapStart, gapEnd, gridStep(chart));
        return {
          lineId: line.id,
          singer,
          time: Math.min(Math.max(time, gapStart), gapEnd),
          auto: stored === null,
          gapStart,
          gapEnd,
        };
      }),
    )
    .toSorted((a, b) => a.time - b.time);
}

/** The longest note or line, for finding what reaches into a window. */
export function longest(items: readonly { duration: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.duration), 0);
}

/** The notes `time` is inside (not at their very start or end). */
export function notesAt<T extends { start: number; duration: number }>(notes: readonly T[], time: number): T[] {
  return notes.filter((note) => note.start < time && note.start + note.duration > time);
}

/** From the first item's start to the last one's end, or null without items. */
export function spanOf(items: readonly { start: number; duration: number }[]): { start: number; end: number } | null {
  if (items.length === 0) return null;
  return {
    start: Math.min(...items.map((item) => item.start)),
    end: Math.max(...items.map((item) => item.start + item.duration)),
  };
}

/** When the last note ends (0 without notes). */
export function chartEnd(notes: readonly DrawnNote[]): number {
  return notes.reduce((end, note) => Math.max(end, note.start + note.duration), 0);
}

/** The line being sung at `time`, else the last one before it, else the first (index into `spans`; -1 if none). */
export function lineIndexAt(spans: readonly LineSpan[], time: number): number {
  if (spans.length === 0) return -1;
  let index = 0;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i]!.start <= time + 1e-6) index = i;
    else break;
  }
  return index;
}

/**
 * The line to step to from `time`: the next one starting after it, or the previous one. Going back from inside a
 * line goes to that line's start first, like a media player's "previous".
 */
export function stepLine(spans: readonly LineSpan[], time: number, direction: 1 | -1): LineSpan | undefined {
  if (direction === 1) return spans.find((span) => span.start > time + 0.05);
  const current = lineIndexAt(spans, time);
  if (current < 0) return undefined;
  if (time - spans[current]!.start > 0.5) return spans[current];
  return spans[Math.max(0, current - 1)];
}
