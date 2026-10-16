/**
 * Copying and pasting notes: a clip holds the notes relative to the first one (timing, pitch, syllable, type) and the
 * line breaks selected with them, before, between or after them. A paste puts the notes in and adds the clip's breaks
 * at the same distance from them; without breaks, pasted notes join the line they land in. The clip's text (its lines'
 * words) goes on the system clipboard too, so pasting elsewhere gives the lyrics.
 */
import type { EditorChart, EditorLine, NoteType } from "~/lib/native/types";

import { occupied, spanAt } from "./breaks";
import { gridFloor, gridStep, lineBreaks, lineText, onGrid } from "./chart";
import type { EditRecorder } from "./document";

const EPSILON = 1e-6;

export interface Clip {
  notes: { offset: number; duration: number; pitch: number; lyric: string; type: NoteType }[];
  /** The line breaks selected with the notes (before, between or after them), relative to the first note. */
  breaks: number[];
  /** The copied lines' words, one line a row. */
  text: string;
}

/**
 * The selected notes as a clip, with the selected line breaks (`selectedBreaks`, by the line they end) from the one
 * before them to the one after; `breaks` are those that went in (a cut removes them). Null when no note is selected or
 * the notes are more than one singer's.
 */
export function copyNotes(
  chart: EditorChart,
  ids: ReadonlySet<number>,
  selectedBreaks: ReadonlySet<number> = new Set(),
): { clip: Clip; breaks: number[] } | null {
  const singers = chart.singers.filter((singer) =>
    singer.lines.some((line) => line.notes.some((note) => ids.has(note.id))),
  );
  if (singers.length !== 1) return null;
  const sung = singers[0]!.lines.filter((line) => line.notes.length > 0);
  const lines = sung
    .map((line) => ({ id: line.id, notes: line.notes.filter((note) => ids.has(note.id)) }))
    .filter((line) => line.notes.length > 0);
  const start = Math.min(...lines.map((line) => line.notes[0]!.start));
  // From the line before the first copied one (its break is the one before them) to the last copied one.
  const from = Math.max(0, sung.findIndex((line) => line.id === lines[0]!.id) - 1);
  const to = sung.findIndex((line) => line.id === lines.at(-1)!.id);
  const around = new Set(sung.slice(from, to + 1).map((line) => line.id));
  const breaks = lineBreaks(chart).filter((item) => around.has(item.lineId) && selectedBreaks.has(item.lineId));
  return {
    clip: {
      notes: lines.flatMap((line) =>
        line.notes.map((note) => ({
          offset: note.start - start,
          duration: note.duration,
          pitch: note.pitch,
          lyric: note.lyric,
          type: note.type,
        })),
      ),
      breaks: breaks.map((item) => item.time - start),
      text: lines.map((line) => lineText(line.notes)).join("\n"),
    },
    breaks: breaks.map((item) => item.lineId),
  };
}

/** Whether `time` is strictly between `a` and `b`, either way round. */
const between = (time: number, a: number, b: number) =>
  time > Math.min(a, b) + EPSILON && time < Math.max(a, b) - EPSILON;

/** A note as a paste places it: one of the singer's, or the clip's (by index). */
type PasteNote =
  | { start: number; existing: { id: number; lineId: number; edited: boolean } }
  | { start: number; pasted: number };

/** A line break after a paste: its time, the line it was (null: the clip's), and the switch the line before it gets. */
interface PasteBreak {
  time: number;
  from: EditorLine | null;
  write: { switchStart: number | null; switchEnd: number | null };
}

/**
 * The singer's line breaks after a paste of `pasted` (on the grid, by start), sorted; two with no note starting between
 * them are one, the singer's own winning (there's no line without notes).
 * - The singer's own stay where they are; a stored one a pasted note covers goes to the nearer edge of the notes
 *   there. A default one among the pasted notes (worked out for the gap before the paste) goes to their nearer end, or
 *   the other, when no note of the singer's starts on the way (it would change line); else it stays.
 * - The clip's (`copied`, times) keep their distance to the pasted notes, but stay after the notes there before them
 *   and before those after them, and out of any note (one before the notes to the start of the notes there, one after
 *   them to their end).
 */
export function breaksAfterPaste(
  lines: readonly EditorLine[],
  drawn: ReadonlyMap<number, number>,
  pasted: readonly { start: number; duration: number }[],
  copied: readonly number[],
  end: number,
): PasteBreak[] {
  const existing = lines.flatMap((line) => line.notes);
  const spans = occupied([...existing, ...pasted]);
  /** Out of any note: the edge of the notes there that `toward` says, else the nearer one. */
  const outside = (time: number, toward?: "start" | "end") => {
    const span = spanAt(spans, time);
    if (!span) return time;
    if (toward) return span[toward];
    return time - span.start <= span.end - time ? span.start : span.end;
  };
  const first = pasted[0]!.start;
  const last = Math.max(...pasted.map((note) => note.start + note.duration));
  const reach = Math.max(...existing.filter((note) => note.start < first - EPSILON).map((n) => n.start + n.duration));
  const next = Math.min(...existing.filter((note) => note.start >= last - EPSILON).map((note) => note.start), end);

  const own = lines.slice(0, -1).map((line): PasteBreak => {
    const time = drawn.get(line.id)!;
    const kept = { switchStart: line.switchStart, switchEnd: line.switchEnd };
    if (line.switchStart === null) {
      if (time <= first + EPSILON || time >= last - EPSILON) return { time, from: line, write: kept };
      const ends = time - first <= last - time ? [first, last] : [last, first];
      const free = ends.find((edge) => !existing.some((note) => between(note.start, time, edge)));
      return { time: free ?? time, from: line, write: kept };
    }
    const moved = outside(time);
    return { time: moved, from: line, write: moved === time ? kept : { switchStart: moved, switchEnd: null } };
  });
  const theirs = copied.map((time): PasteBreak => {
    const at =
      time <= first + EPSILON
        ? outside(Math.min(first, Math.max(time, reach)), "start")
        : time >= last - EPSILON
          ? outside(Math.max(last, Math.min(time, next)), "end")
          : outside(time);
    return { time: at, from: null, write: { switchStart: at, switchEnd: null } };
  });

  // Two breaks with no note starting between them are one.
  const starts = [...existing, ...pasted].map((note) => note.start).toSorted((a, b) => a - b);
  const startsBetween = (a: number, b: number) => starts.some((start) => start >= a - EPSILON && start < b - EPSILON);
  const result: PasteBreak[] = [];
  for (const item of [...own, ...theirs].toSorted((a, b) => a.time - b.time)) {
    const previous = result.at(-1);
    if (!previous || startsBetween(previous.time, item.time)) result.push(item);
    else if (previous.from === null && item.from !== null) result[result.length - 1] = item;
  }
  return result;
}

/** The notes split into stretches by the breaks: each note in the one it starts in, and the break after each. */
function stretches(notes: readonly PasteNote[], breaks: readonly PasteBreak[]) {
  const result: { notes: PasteNote[]; end: PasteBreak | null }[] = [{ notes: [], end: null }];
  let next = 0;
  for (const note of notes) {
    while (next < breaks.length && note.start >= breaks[next]!.time - EPSILON) {
      result.at(-1)!.end = breaks[next]!;
      result.push({ notes: [], end: null });
      next++;
    }
    result.at(-1)!.notes.push(note);
  }
  // Two breaks always have a note between them (`breaksAfterPaste`): only one before every note leaves a stretch
  // without notes (one after every note is never reached).
  return result.filter((stretch) => stretch.notes.length > 0);
}

/**
 * Pastes a clip's notes for the singer from `at` (on the grid), as one edit: the notes go to the line they start in,
 * between the breaks `breaksAfterPaste` works out. Each stretch keeps the line most of its notes were in, else gets a
 * new one; lines left without notes go, and only lines whose break changed are written. Notes past the song's end are
 * cut short there or left out. Returns the new notes' ids (none when nothing fits).
 *
 * New lines are made before their notes, and emptied ones deleted after theirs moved, so the edit applies (and undoes)
 * in order.
 */
export function pasteNotes(
  tx: EditRecorder,
  chart: EditorChart,
  clip: Clip,
  target: { singerId: number; at: number; length: number },
): number[] {
  const singer = chart.singers.find((item) => item.id === target.singerId);
  if (!singer) return [];
  const step = gridStep(chart);
  const at = onGrid(chart, target.at);
  const end = gridFloor(chart, target.length);

  /** The pasted notes, cut short at the song's end (those starting a step before it or later are left out). */
  const pasted = clip.notes.flatMap((note) => {
    const start = onGrid(chart, at + note.offset);
    if (start > end - step + EPSILON) return [];
    const stop = Math.min(end, Math.max(start + step, onGrid(chart, start + note.duration)));
    return [{ ...note, start, duration: stop - start }];
  });
  if (pasted.length === 0) return [];

  const lines = singer.lines.filter((line) => line.notes.length > 0);
  const drawn = new Map(lineBreaks(chart).map((item) => [item.lineId, item.time]));
  const copied = clip.breaks.map((offset) => onGrid(chart, at + offset));
  const breaks = breaksAfterPaste(lines, drawn, pasted, copied, end);
  const notes: PasteNote[] = [
    ...lines.flatMap((line) =>
      line.notes.map((note) => ({
        start: note.start,
        existing: { id: note.id, lineId: line.id, edited: note.edited },
      })),
    ),
    ...pasted.map((note, index) => ({ start: note.start, pasted: index })),
  ].toSorted((a, b) => a.start - b.start);
  const groups = stretches(notes, breaks);

  // Each stretch keeps the line most of its notes were in (each line once), else gets a new one (made before its
  // notes).
  const kept = new Set<number>();
  const lineIds = groups.map((group) => {
    const counts = new Map<number, number>();
    for (const note of group.notes) {
      if ("existing" in note) counts.set(note.existing.lineId, (counts.get(note.existing.lineId) ?? 0) + 1);
    }
    const best = [...counts].filter(([id]) => !kept.has(id)).toSorted((x, y) => y[1] - x[1])[0]?.[0];
    if (best === undefined) return tx.createLine({ singerId: singer.id, switchStart: null, switchEnd: null });
    kept.add(best);
    return best;
  });

  const created: number[] = [];
  groups.forEach((group, g) => {
    const lineId = lineIds[g]!;
    for (const note of group.notes) {
      if ("existing" in note) {
        // Changing line isn't changing the note: it keeps its `edited`.
        const { id, lineId: was, edited } = note.existing;
        if (was !== lineId) tx.updateNote(id, { lineId, edited });
        continue;
      }
      const source = pasted[note.pasted]!;
      created[note.pasted] = tx.createNote({
        lineId,
        start: source.start,
        duration: source.duration,
        pitch: source.pitch,
        lyric: source.lyric,
        type: source.type,
      });
    }
    // The break after it, as it is to be (the last line keeps what the singer's last line had; nothing changes when
    // its line is the same one).
    const last = lines.at(-1);
    const write = group.end?.write ?? (last ? { switchStart: last.switchStart, switchEnd: last.switchEnd } : null);
    if (write) tx.updateLine(lineId, write);
  });
  // Lines whose notes all went elsewhere go, after their notes moved.
  for (const line of lines) if (!kept.has(line.id)) tx.deleteLine(line.id);
  return created;
}
