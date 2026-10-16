import type { EditorChart, RangeChart } from "~/lib/native/types";

import { intersectsRange, type TimeRange } from "../chart-range";
import { gridCeil, gridFloor, gridStep, lineText, onGrid } from "./chart";
import type { EditRecorder } from "./document";

const EPSILON = 1e-6;

/**
 * Expands a reviewed passage to whole notes and grid steps, including chains of overlapping notes. Its end only goes
 * past `duration` (the audio's) for a note that does: the song rarely ends on a grid step.
 */
export function rangeScope(chart: EditorChart, singerId: number, requested: TimeRange, duration = Infinity) {
  const singer = chart.singers.find((item) => item.id === singerId);
  if (
    !singer ||
    !Number.isFinite(requested.start) ||
    !Number.isFinite(requested.end) ||
    requested.end <= requested.start ||
    !Number.isFinite(chart.bpm) ||
    chart.bpm <= 0 ||
    !Number.isFinite(chart.gap)
  )
    return null;
  const notes = singer.lines.flatMap((line) => line.notes);
  const range = {
    start: Math.max(0, gridFloor(chart, requested.start)),
    end: Math.min(gridCeil(chart, requested.end), Math.max(requested.end, duration)),
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const note of notes) {
      if (!intersectsRange(note, range)) continue;
      const noteEnd = note.start + note.duration;
      const start = note.start < range.start - EPSILON ? Math.max(0, gridFloor(chart, note.start)) : range.start;
      const end = noteEnd > range.end + EPSILON ? gridCeil(chart, noteEnd) : range.end;
      if (start < range.start - EPSILON || end > range.end + EPSILON) {
        range.start = start;
        range.end = end;
        changed = true;
      }
    }
  }
  const replaced = notes.filter((note) => intersectsRange(note, range));
  return {
    ...range,
    count: replaced.length,
    text: singer.lines
      .map((line) => lineText(line.notes.filter((note) => intersectsRange(note, range))))
      .filter(Boolean)
      .join("\n"),
  };
}

/** Validate before recording any deletion. A bad or empty result must never erase existing notes. */
export function validRangeChart(chart: EditorChart, range: TimeRange, result: RangeChart): boolean {
  if (
    result.bpm !== chart.bpm ||
    result.gap !== chart.gap ||
    !result.lines.length ||
    result.breaks.length !== result.lines.length - 1
  )
    return false;
  let end = range.start;
  const onTick = (time: number) => Number.isFinite(time) && Math.abs(onGrid(chart, time) - time) < EPSILON;
  for (const [i, line] of result.lines.entries()) {
    if (!line.notes.length || (i < result.lines.length - 1 && !result.lines[i + 1]!.notes.length)) return false;
    for (const note of line.notes) {
      if (
        !onTick(note.start) ||
        !onTick(note.start + note.duration) ||
        !Number.isInteger(note.pitch) ||
        note.duration < gridStep(chart) - EPSILON ||
        note.start < end - EPSILON ||
        note.start + note.duration > range.end + EPSILON ||
        note.type !== "normal" ||
        !note.lyric
      )
        return false;
      end = note.start + note.duration;
    }
    if (i < result.breaks.length) {
      const time = result.breaks[i]!;
      if (!onTick(time) || time < end - EPSILON || time > result.lines[i + 1]!.notes[0]!.start + EPSILON) return false;
    }
  }
  return true;
}

/** Replaces only this singer's reviewed passage, with independent lines and exact undo through the recorder. */
export function replaceRange(
  tx: EditRecorder,
  chart: EditorChart,
  singerId: number,
  range: TimeRange,
  result: RangeChart,
): number[] {
  const singer = chart.singers.find((item) => item.id === singerId);
  if (!singer || !validRangeChart(chart, range, result)) return [];
  const notes = singer.lines.flatMap((line) => line.notes);
  if (
    notes.some(
      (note) =>
        intersectsRange(note, range) &&
        (note.start < range.start - EPSILON || note.start + note.duration > range.end + EPSILON),
    )
  )
    return [];
  // The last line starting before the passage's end holds the break to the line after it. Unless a suffix of it
  // survives (and keeps it), that break now follows the last generated line.
  const last = singer.lines.findLast((line) => line.notes.some((note) => note.start < range.end - EPSILON));
  const outgoing =
    last && !last.notes.some((note) => note.start >= range.end - EPSILON)
      ? { id: last.id, start: last.switchStart, end: last.switchEnd }
      : null;
  let prefix: { id: number; end: number } | undefined;
  for (const line of singer.lines) {
    const before = line.notes.filter((note) => note.start + note.duration <= range.start + EPSILON);
    const after = line.notes.filter((note) => note.start >= range.end - EPSILON);
    const replaced = line.notes.filter((note) => intersectsRange(note, range));
    if (before.length) prefix = { id: line.id, end: Math.max(...before.map((note) => note.start + note.duration)) };
    if (before.length && after.length) {
      const suffix = tx.createLine({ singerId, switchStart: line.switchStart, switchEnd: line.switchEnd });
      for (const note of after) tx.updateNote(note.id, { lineId: suffix, edited: note.edited });
    }
    for (const note of replaced) tx.deleteNote(note.id);
    if (replaced.length && !before.length && !after.length) tx.deleteLine(line.id);
  }
  if (prefix) {
    const line = tx.line(prefix.id)!;
    const first = result.lines[0]!.notes[0]!.start;
    if (prefix.id === outgoing?.id) {
      // Its break moved past the generated lines; the one before them is the default.
      if (line.switchStart !== null || line.switchEnd !== null)
        tx.updateLine(prefix.id, { switchStart: null, switchEnd: null });
    } else if (line.switchStart !== null) {
      const start = Math.min(first, Math.max(prefix.end, line.switchStart));
      const end = line.switchEnd === null ? null : Math.min(first, Math.max(start, line.switchEnd));
      tx.updateLine(prefix.id, { switchStart: start, switchEnd: end });
    }
  }
  const generatedEnd = result.lines.at(-1)!.notes.at(-1)!;
  const tailStart =
    outgoing?.start == null ? null : Math.max(generatedEnd.start + generatedEnd.duration, outgoing.start);
  const tailEnd = tailStart === null || outgoing?.end == null ? null : Math.max(tailStart, outgoing.end);
  const created: number[] = [];
  result.lines.forEach((line, i) => {
    const final = i === result.lines.length - 1;
    const lineId = tx.createLine({
      singerId,
      switchStart: final ? tailStart : (result.breaks[i] ?? null),
      switchEnd: final ? tailEnd : null,
    });
    for (const note of line.notes) created.push(tx.createNote({ ...note, lineId }));
  });
  return created;
}
