/** The editor's chart, flattened into what is drawn: notes in time order and each line's span and text. */
import type { EditorChart, EditorNote } from "~/lib/native/types";

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

/** A gap longer than this gets its default switch a little after the last note, not right at its end. */
const LONG_GAP = 2;
const LONG_GAP_DELAY = 1;

/** When the next line appears if the chart doesn't say: right after the last note, or a second later in a long gap. */
export function defaultSwitch(gapStart: number, gapEnd: number): number {
  return gapEnd - gapStart > LONG_GAP ? gapStart + LONG_GAP_DELAY : gapStart;
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
        const last = line.notes.at(-1)!;
        const gapStart = last.start + last.duration;
        const gapEnd = Math.max(gapStart, lines[i + 1]!.notes[0]!.start);
        const stored = line.switchStart;
        const time = stored ?? defaultSwitch(gapStart, gapEnd);
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
