/**
 * Line breaks as markers: everything between two of a singer's breaks is one line, and a break's time is its switch
 * (when the game shows the next line). Moving a break retimes the switch, and moving it across notes moves them to the
 * other line: every note belongs to the line it starts in. A break keeps at least one note on either side, so it can't
 * pass its neighbours. Adding one splits a line in two, removing one joins two. Breaks are on the grid and never inside
 * a note: they are kept out of the stretches notes cover (`occupied`; overlapping notes count as one stretch).
 */
import { defaultSwitch } from "@tunestudio/ultrastar";

import type { EditorChart } from "~/lib/native/types";

import { gridCeil, gridFloor, gridStep, lastEnd, onGrid } from "./chart";
import type { EditRecorder } from "./document";

const EPSILON = 1e-6;

/** A singer's lines with notes, in order, with the line `lineId` among them (at `index`). */
export function linesAround(chart: EditorChart, lineId: number) {
  for (const singer of chart.singers) {
    const lines = singer.lines.filter((line) => line.notes.length > 0);
    const index = lines.findIndex((line) => line.id === lineId);
    if (index >= 0) return { singerId: singer.id, lines, index };
  }
  return null;
}

/** A stretch of time notes cover. */
export interface Span {
  start: number;
  end: number;
}

/** The stretches the notes cover, overlapping ones merged, in order. */
export function occupied(notes: readonly { start: number; duration: number }[]): Span[] {
  const sorted = notes
    .map((note) => ({ start: note.start, end: note.start + note.duration }))
    .toSorted((a, b) => a.start - b.start);
  const spans: Span[] = [];
  for (const span of sorted) {
    const last = spans.at(-1);
    if (last && span.start < last.end - EPSILON) last.end = Math.max(last.end, span.end);
    else spans.push({ ...span });
  }
  return spans;
}

/** The stretch `time` is strictly inside (a break there would be inside a note), if any. */
export function spanAt(spans: readonly Span[], time: number): Span | undefined {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const span = spans[middle]!;
    if (span.end <= time + EPSILON) low = middle + 1;
    else if (span.start >= time - EPSILON) high = middle - 1;
    else return span;
  }
  return undefined;
}

/**
 * Where the break after line `lineId` can go: after the line's first note starts (a step on, so it keeps a note) up to
 * the start of the next line's last note (which then still has one). Null when the line is a singer's last.
 */
export function breakRange(chart: EditorChart, lineId: number): { min: number; max: number } | null {
  const around = linesAround(chart, lineId);
  const line = around?.lines[around.index];
  const next = around?.lines[around.index + 1];
  if (!line || !next) return null;
  return { min: line.notes[0]!.start + gridStep(chart), max: next.notes.at(-1)!.start };
}

/** `time` on the nearest grid line inside `range`. */
export function snapBreak(chart: EditorChart, range: { min: number; max: number }, time: number): number {
  return Math.min(Math.max(onGrid(chart, time), gridCeil(chart, range.min)), gridFloor(chart, range.max));
}

/**
 * Where the break after line `lineId` goes when dragged to `time`: the nearest place it may be, on the grid within
 * `breakRange` and never inside a note (over notes, the nearer edge of the stretch they cover: its start sends them to
 * the next line, its end keeps them). Null when the line is a singer's last, or there is no such place.
 */
export function breakLanding(chart: EditorChart, lineId: number, time: number): number | null {
  const around = linesAround(chart, lineId);
  const line = around?.lines[around.index];
  const next = around?.lines[around.index + 1];
  const range = breakRange(chart, lineId);
  if (!line || !next || !range) return null;
  const low = gridCeil(chart, range.min);
  const high = gridFloor(chart, range.max);
  const at = snapBreak(chart, range, time);
  const span = spanAt(occupied([...line.notes, ...next.notes]), at);
  if (!span) return at;
  const edges = [span.start, span.end].filter((edge) => edge >= low - EPSILON && edge <= high + EPSILON);
  if (edges.length === 0) return null;
  return edges.reduce((best, edge) => (Math.abs(edge - time) < Math.abs(best - time) ? edge : best));
}

/**
 * Where the break after line `lineId` (at `time`) goes a grid step one way: over notes there, to their far edge (the
 * notes change line). Null when it can't go that way.
 */
export function stepBreak(chart: EditorChart, lineId: number, time: number, direction: 1 | -1): number | null {
  const around = linesAround(chart, lineId);
  const line = around?.lines[around.index];
  const next = around?.lines[around.index + 1];
  const range = breakRange(chart, lineId);
  if (!line || !next || !range) return null;
  let at = onGrid(chart, time) + direction * gridStep(chart);
  const span = spanAt(occupied([...line.notes, ...next.notes]), at);
  if (span) at = direction === 1 ? span.end : span.start;
  if (at < gridCeil(chart, range.min) - EPSILON || at > gridFloor(chart, range.max) + EPSILON) return null;
  return at;
}

/**
 * Moves the break after line `lineId` to `time` (on the grid, within `breakRange`): the notes of the two lines go to
 * the one they start in, and the switch is stored (after the earlier line's last note). Returns false when there is
 * no next line.
 */
export function moveBreak(tx: EditRecorder, chart: EditorChart, lineId: number, time: number): boolean {
  const around = linesAround(chart, lineId);
  const line = around?.lines[around.index];
  const next = around?.lines[around.index + 1];
  const at = breakLanding(chart, lineId, time);
  if (!line || !next || at === null) return false;
  let end = -Infinity;
  for (const note of [...line.notes, ...next.notes]) {
    const target = note.start < at - EPSILON ? line.id : next.id;
    if (target === line.id) end = Math.max(end, note.start + note.duration);
    // Changing line isn't changing the note: it keeps its `edited`.
    // Its `edited` as it is now (an auto pitch result may have landed during the drag).
    const current = tx.note(note.id);
    if (current && current.lineId !== target) tx.updateNote(note.id, { lineId: target, edited: current.edited });
  }
  tx.updateLine(line.id, { switchStart: Math.max(at, end), switchEnd: null });
  return true;
}

/**
 * Adds a break at `time` in the singer's line there: the notes starting from it go to a new line after it, which
 * takes the line's own break (the new one ends `split`, the line's old one now ends `created`). A time inside a note
 * moves to that note's end. The break is stored there, or with `automatic` keeps the default timing (`time` only says
 * where the line splits). Returns null when it wouldn't leave a note on either side.
 */
export function addBreak(
  tx: EditRecorder,
  chart: EditorChart,
  singerId: number,
  time: number,
  automatic = false,
): { split: number; created: number } | null {
  const singer = chart.singers.find((item) => item.id === singerId);
  const lines = singer?.lines.filter((line) => line.notes.length > 0) ?? [];
  let at = onGrid(chart, time);
  // The line `at` falls in: the last one starting before it.
  const line = lines.findLast((item) => item.notes[0]!.start < at - EPSILON);
  if (!line) return null;
  // Inside notes: after them (overlapping ones count as one stretch).
  at = spanAt(occupied(line.notes), at)?.end ?? at;
  const before = line.notes.filter((note) => note.start < at - EPSILON);
  const after = line.notes.filter((note) => note.start >= at - EPSILON);
  if (before.length === 0 || after.length === 0) return null;
  const created = tx.createLine({ singerId, switchStart: line.switchStart, switchEnd: line.switchEnd });
  for (const note of after) tx.updateNote(note.id, { lineId: created, edited: note.edited });
  tx.updateLine(line.id, { switchStart: automatic ? null : at, switchEnd: null });
  return { split: line.id, created };
}

/**
 * Adds a break with default timing after the selected notes `ids` (the last of them to start): the notes of its line
 * that start later go to a new line (`addBreak`). A string says why it can't: the notes are both singers', or nothing
 * comes after them in their line.
 */
export function breakAfter(
  tx: EditRecorder,
  chart: EditorChart,
  ids: ReadonlySet<number>,
): { singerId: number; split: number; created: number } | string {
  const found = chart.singers.flatMap((singer) =>
    singer.lines.flatMap((line) => line.notes.filter((note) => ids.has(note.id)).map((note) => ({ singer, note }))),
  );
  if (new Set(found.map((item) => item.singer.id)).size > 1) return "Select notes of one singer.";
  const last = found.reduce<(typeof found)[number] | undefined>(
    (latest, item) => (!latest || item.note.start > latest.note.start ? item : latest),
    undefined,
  );
  if (!last) return "Select a note first.";
  const added = addBreak(tx, chart, last.singer.id, last.note.start + last.note.duration, true);
  if (added) return { singerId: last.singer.id, ...added };
  // Nothing after it, or only notes inside a longer one it is in too.
  const line = last.singer.lines.find((item) => item.notes.includes(last.note))!;
  return line.notes.some((note) => note.start > last.note.start)
    ? "A line break can't go inside a note."
    : "That's already the end of a line.";
}

/**
 * Removes the break after line `lineId`: the next line's notes join it, and it ends where that line did (its break,
 * which ended the next line, now ends `lineId`). Returns the next line's id (gone now), or null without one.
 */
export function removeBreak(tx: EditRecorder, chart: EditorChart, lineId: number): number | null {
  const around = linesAround(chart, lineId);
  const line = around?.lines[around.index];
  const next = around?.lines[around.index + 1];
  if (!line || !next) return null;
  for (const note of next.notes) tx.updateNote(note.id, { lineId: line.id, edited: note.edited });
  tx.updateLine(line.id, { switchStart: next.switchStart, switchEnd: next.switchEnd });
  tx.deleteLine(next.id);
  return next.id;
}

/**
 * Where a break added at `time` goes: in the gap nearest to it between two notes of the singer's line there, at that
 * gap's default switch. A string says why there is none: the gap nearest to it is between two lines, where a break is
 * already, or there is no gap (past the last line's notes, or a line of one note).
 */
export function nearestGap(chart: EditorChart, singerId: number, time: number): number | string {
  const lines = chart.singers.find((item) => item.id === singerId)?.lines.filter((line) => line.notes.length > 0);
  const index = lines
    ? Math.max(
        0,
        lines.findLastIndex((item) => item.notes[0]!.start <= time),
      )
    : -1;
  const line = lines?.[index];
  const noGap = "There's no gap between notes here for a line break.";
  if (!lines || !line) return noGap;
  const distance = (gapStart: number, gapEnd: number) =>
    time < gapStart ? gapStart - time : time > gapEnd ? time - gapEnd : 0;
  if (index === lines.length - 1 && time >= lastEnd(line.notes)) return noGap;
  let best: { distance: number; at: number | null } | null = null;
  const consider = (gapStart: number, gapEnd: number, at: number | null) => {
    const far = distance(gapStart, gapEnd);
    if (!best || far < best.distance) best = { distance: far, at };
  };
  // The gaps on either side of the line have their breaks already.
  const previous = lines[index - 1];
  if (previous) consider(lastEnd(previous.notes), line.notes[0]!.start, null);
  const next = lines[index + 1];
  if (next) consider(lastEnd(line.notes), next.notes[0]!.start, null);
  for (let i = 0; i < line.notes.length - 1; i++) {
    const gapStart = line.notes[i]!.start + line.notes[i]!.duration;
    const gapEnd = line.notes[i + 1]!.start;
    consider(gapStart, gapEnd, Math.min(defaultSwitch(gapStart, Math.max(gapStart, gapEnd), gridStep(chart)), gapEnd));
  }
  const found = best as { distance: number; at: number | null } | null;
  if (!found) return noGap;
  return found.at ?? "There's already a line break here.";
}
