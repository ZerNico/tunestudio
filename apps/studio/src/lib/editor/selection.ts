/** Which notes a click, a Shift-click, a selection box or Tab selects (over the notes as drawn, by start time). */
import type { DrawnNote } from "./chart";

/** Shift-click: the notes of the clicked note's singer from the anchor to it, either way round. */
export function rangeSelection(notes: readonly DrawnNote[], anchor: number, target: number): number[] {
  const from = notes.find((note) => note.id === anchor);
  const to = notes.find((note) => note.id === target);
  if (!to) return [];
  if (!from || from.singer !== to.singer) return [to.id];
  const [low, high] = from.start <= to.start ? [from.start, to.start] : [to.start, from.start];
  return notes
    .filter((note) => note.singer === to.singer && note.start >= low && note.start <= high)
    .map((note) => note.id);
}

/** Cmd/Ctrl-click: the selection with the note added, or taken out. */
export function toggled(selection: readonly number[], id: number): number[] {
  return selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id];
}

/** The notes a selection box touches: from `from` to `to` seconds, `low` to `high` pitch (both inclusive). */
export function notesInBox(
  notes: readonly DrawnNote[],
  box: { from: number; to: number; low: number; high: number },
): number[] {
  return notes
    .filter(
      (note) =>
        note.start < box.to && note.start + note.duration > box.from && note.pitch >= box.low && note.pitch <= box.high,
    )
    .map((note) => note.id);
}

/**
 * Tab and Shift+Tab: the note after the selection's last (or before its first), of the same singer. With nothing
 * selected, the first note from `time` on (or the last before it).
 */
export function adjacentNote(
  notes: readonly DrawnNote[],
  selection: readonly number[],
  direction: 1 | -1,
  time: number,
): DrawnNote | undefined {
  const selected = notes.filter((note) => selection.includes(note.id));
  if (selected.length === 0) {
    return direction === 1 ? notes.find((note) => note.start >= time) : notes.findLast((note) => note.start < time);
  }
  const edge = direction === 1 ? selected.at(-1)! : selected[0]!;
  const index = notes.indexOf(edge);
  const sameSinger = (note: DrawnNote) => note.singer === edge.singer;
  return direction === 1 ? notes.slice(index + 1).find(sameSinger) : notes.slice(0, index).findLast(sameSinger);
}
