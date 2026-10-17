/**
 * Duet commands, each one edit: adding the second singer, removing one (its notes deleted or moved to the other), and
 * moving or copying notes to the other singer. Moved notes keep their times, `edited` and line breaks (with their
 * switches): they go into the other singer's lines as a paste does (`insertNotes`), so the same line rules hold there,
 * but off the grid and at exactly their times.
 */
import type { EditorChart, EditorSinger } from "~/lib/native/types";

import { lineBreaks } from "./chart";
import { insertNotes, type PlacedBreak } from "./clipboard";
import type { EditRecorder } from "./document";
import { deleteSelection } from "./edits";

const EPSILON = 1e-6;

/** How a singer is called in the editor: their name, else P1 or P2. */
export function singerLabel(singer: Pick<EditorSinger, "index" | "name">): string {
  return singer.name || `P${singer.index}`;
}

/** The singer whose notes these all are (null: none, or two singers'). */
export function singerOf(chart: EditorChart, ids: ReadonlySet<number>): EditorSinger | null {
  const singers = chart.singers.filter((singer) =>
    singer.lines.some((line) => line.notes.some((note) => ids.has(note.id))),
  );
  return singers.length === 1 ? singers[0]! : null;
}

/** The other singer of a duet. */
export function otherSinger(chart: EditorChart, singerId: number): EditorSinger | null {
  return chart.singers.find((singer) => singer.id !== singerId) ?? null;
}

/** Adds the second singer (P2, or P1 when only P2 is left), without notes. Returns its id. */
export function addSinger(tx: EditRecorder, chart: EditorChart): number | null {
  if (chart.singers.length >= 2) return null;
  const index = chart.singers.some((singer) => singer.index === 1) ? 2 : 1;
  return tx.createSinger({ index, name: null });
}

/**
 * The line breaks that go with notes moved to another singer (by the line they end): every one from the first line
 * with moved notes to the last, the one before them when they start a line, and the one after them when they end one.
 */
function breaksWith(singer: EditorSinger, ids: ReadonlySet<number>): Set<number> {
  const sung = singer.lines.filter((line) => line.notes.length > 0);
  const lines = sung.flatMap((line, i) => (line.notes.some((note) => ids.has(note.id)) ? [i] : []));
  const result = new Set<number>();
  if (lines.length === 0) return result;
  const first = lines[0]!;
  const last = lines.at(-1)!;
  for (let i = first; i < last; i++) result.add(sung[i]!.id);
  if (ids.has(sung[first]!.notes[0]!.id) && first > 0) result.add(sung[first - 1]!.id);
  if (ids.has(sung[last]!.notes.at(-1)!.id) && last < sung.length - 1) result.add(sung[last]!.id);
  return result;
}

/**
 * Moves (or copies) one singer's notes to the other, with their line breaks; the notes keep their times and `edited`,
 * and the breaks their switches (an automatic one stays automatic). Refused when the other singer sings there already,
 * unless `overlap` (a removed singer's notes must never be lost). Returns the notes made for the other singer, or why
 * it can't.
 */
export function transferNotes(
  tx: EditRecorder,
  chart: EditorChart,
  ids: ReadonlySet<number>,
  options: { copy: boolean; overlap?: boolean },
): { ids: number[] } | { refused: string } {
  const from = singerOf(chart, ids);
  if (!from) return { refused: "Select one singer's notes." };
  const to = otherSinger(chart, from.id);
  if (!to) return { refused: "Add a second singer first." };
  const notes = from.lines.flatMap((line) => line.notes).filter((note) => ids.has(note.id));
  const theirs = to.lines.flatMap((line) => line.notes);
  const sings = notes.some((note) =>
    theirs.some(
      (other) =>
        other.start < note.start + note.duration - EPSILON && other.start + other.duration > note.start + EPSILON,
    ),
  );
  if (sings && !options.overlap) return { refused: `${singerLabel(to)} already sings there.` };
  const start = Math.min(...notes.map((note) => note.start));
  const end = Math.max(...notes.map((note) => note.start + note.duration));
  const going = breaksWith(from, ids);
  const switches = new Map(from.lines.map((line) => [line.id, line]));
  const breaks: PlacedBreak[] = lineBreaks(chart)
    .filter((item) => going.has(item.lineId))
    .map((item) => {
      const line = switches.get(item.lineId)!;
      return { time: item.time, stored: { switchStart: line.switchStart, switchEnd: line.switchEnd } };
    });
  // Their own lines there (automatic breaks around them, unless they bring theirs), unless they land in a gap inside
  // one of the other singer's lines: then they join it.
  const inside = to.lines.some(
    (line) =>
      line.notes.length > 0 &&
      line.notes[0]!.start < start - EPSILON &&
      Math.max(...line.notes.map((note) => note.start + note.duration)) > end + EPSILON,
  );
  const automatic = { switchStart: null, switchEnd: null };
  if (!inside && !breaks.some((item) => item.time <= start + EPSILON)) breaks.push({ time: start, stored: automatic });
  if (!inside && !breaks.some((item) => item.time >= end - EPSILON)) breaks.push({ time: end, stored: automatic });
  if (!options.copy) deleteSelection(tx, chart, ids);
  // Notes keep their times, even past the audio's end (where the checks show them): nothing moved is left out.
  return { ids: insertNotes(tx, chart, to.id, notes, breaks, { end: Infinity, together: options.overlap }) };
}

/**
 * Removes a singer: its notes deleted, or moved to the other singer (`merge`; where both sing, they overlap, for the
 * checks to show). The other singer becomes P1. Returns the moved notes' new ids.
 */
export function removeSinger(
  tx: EditRecorder,
  chart: EditorChart,
  singerId: number,
  options: { merge: boolean },
): number[] {
  const singer = chart.singers.find((item) => item.id === singerId);
  const other = otherSinger(chart, singerId);
  if (!singer || !other) return [];
  const ids = new Set(singer.lines.flatMap((line) => line.notes.map((note) => note.id)));
  let moved: number[] = [];
  if (ids.size > 0) {
    if (options.merge) {
      const result = transferNotes(tx, chart, ids, { copy: false, overlap: true });
      if ("ids" in result) moved = result.ids;
    } else deleteSelection(tx, chart, ids);
  }
  // Lines without notes too, before the singer (its lines have to go first).
  for (const line of singer.lines) tx.deleteLine(line.id);
  tx.deleteSinger(singer.id);
  if (other.index !== 1) tx.updateSinger(other.id, { index: 1 });
  return moved;
}
