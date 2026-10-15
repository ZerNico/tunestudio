/**
 * Line breaks as markers: everything between two of a singer's breaks is one line, and a break's time is its switch
 * (when the game shows the next line). Moving a break retimes the switch, and moving it across notes moves them to the
 * other line: every note belongs to the line it starts in. A break keeps at least one note on either side, so it can't
 * pass its neighbours. Adding one splits a line in two, removing one joins two. Breaks are on the grid and never inside
 * a note: they are kept out of the stretches notes cover (`occupied`; overlapping notes count as one stretch).
 */
import type { EditorChart } from "~/lib/native/types";

import { defaultSwitch } from "./chart";
import type { EditRecorder } from "./document";
import { gridCeil, gridFloor, gridStep, onGrid } from "./edits";

const EPSILON = 1e-6;

/** A singer's lines with notes, in order, with the line `lineId` among them. */
function linesAround(chart: EditorChart, lineId: number) {
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
    if (tx.note(note.id)?.lineId !== target) tx.updateNote(note.id, { lineId: target, edited: note.edited });
  }
  tx.updateLine(line.id, { switchStart: Math.max(at, end), switchEnd: null });
  return true;
}

/**
 * Adds a break at `time` in the singer's line there: the notes starting from it go to a new line after it. A time
 * inside a note moves to that note's end. Returns false when it wouldn't leave a note on either side.
 */
export function addBreak(tx: EditRecorder, chart: EditorChart, singerId: number, time: number): boolean {
  const singer = chart.singers.find((item) => item.id === singerId);
  const lines = singer?.lines.filter((line) => line.notes.length > 0) ?? [];
  let at = onGrid(chart, time);
  // The line `at` falls in: the last one starting before it.
  const line = lines.findLast((item) => item.notes[0]!.start < at - EPSILON);
  if (!line) return false;
  // Inside notes: after them (overlapping ones count as one stretch).
  at = spanAt(occupied(line.notes), at)?.end ?? at;
  const before = line.notes.filter((note) => note.start < at - EPSILON);
  const after = line.notes.filter((note) => note.start >= at - EPSILON);
  if (before.length === 0 || after.length === 0) return false;
  const created = tx.createLine({ singerId, switchStart: line.switchStart, switchEnd: line.switchEnd });
  for (const note of after) tx.updateNote(note.id, { lineId: created, edited: note.edited });
  tx.updateLine(line.id, { switchStart: at, switchEnd: null });
  return true;
}

/** Removes the break after line `lineId`: the next line's notes join it, and it ends where that line did. */
export function removeBreak(tx: EditRecorder, chart: EditorChart, lineId: number): boolean {
  const around = linesAround(chart, lineId);
  const line = around?.lines[around.index];
  const next = around?.lines[around.index + 1];
  if (!line || !next) return false;
  for (const note of next.notes) tx.updateNote(note.id, { lineId: line.id, edited: note.edited });
  tx.updateLine(line.id, { switchStart: next.switchStart, switchEnd: next.switchEnd });
  tx.deleteLine(next.id);
  return true;
}

/**
 * Where a break added at `time` goes: in the gap nearest to it between two notes of the singer's line there, at that
 * gap's default switch. Null when the line has no gap.
 */
export function nearestGap(chart: EditorChart, singerId: number, time: number): number | null {
  const lines = chart.singers.find((item) => item.id === singerId)?.lines.filter((line) => line.notes.length > 0);
  const line = lines?.findLast((item) => item.notes[0]!.start <= time) ?? lines?.[0];
  if (!line || line.notes.length < 2) return null;
  let best: { distance: number; at: number } | null = null;
  for (let i = 0; i < line.notes.length - 1; i++) {
    const gapStart = line.notes[i]!.start + line.notes[i]!.duration;
    const gapEnd = line.notes[i + 1]!.start;
    const distance = time < gapStart ? gapStart - time : time > gapEnd ? time - gapEnd : 0;
    if (!best || distance < best.distance)
      best = { distance, at: Math.min(defaultSwitch(gapStart, Math.max(gapStart, gapEnd)), gapEnd) };
  }
  return best?.at ?? null;
}
