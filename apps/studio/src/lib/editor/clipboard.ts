/**
 * Copying and pasting notes: a clip holds the notes relative to the first one (timing, pitch, syllable, type) and the
 * line breaks between them, so a pasted chorus has its lines (`pasteNotes` keeps the line rules). The clip's text (its lines' words) goes on the system
 * clipboard too, so pasting elsewhere gives the lyrics.
 */
import type { EditorChart, NoteType } from "~/lib/native/types";

import { occupied, spanAt } from "./breaks";
import { lineBreaks, lineText } from "./chart";
import type { EditRecorder } from "./document";
import { gridFloor, gridStep, onGrid } from "./edits";

const EPSILON = 1e-6;

export interface Clip {
  notes: { offset: number; duration: number; pitch: number; lyric: string; type: NoteType }[];
  /** The line breaks between the copied lines, relative to the first note. */
  breaks: number[];
  /** The copied lines' words, one line a row. */
  text: string;
  /**
   * Whether it began at a line's first note and ended at a line's last: whole lines paste as their own lines (with a
   * break before and after), a part of one joins the line it lands in.
   */
  startsLine: boolean;
  endsLine: boolean;
}

/** The selected notes as a clip, or null when nothing is selected or the notes are more than one singer's. */
export function copyNotes(chart: EditorChart, ids: ReadonlySet<number>): Clip | null {
  const singers = chart.singers.filter((singer) =>
    singer.lines.some((line) => line.notes.some((note) => ids.has(note.id))),
  );
  if (singers.length !== 1) return null;
  const lines = singers[0]!.lines
    .map((line) => ({ id: line.id, all: line.notes, notes: line.notes.filter((note) => ids.has(note.id)) }))
    .filter((line) => line.notes.length > 0);
  const start = Math.min(...lines.map((line) => line.notes[0]!.start));
  const breaks = lineBreaks(chart);
  return {
    notes: lines.flatMap((line) =>
      line.notes.map((note) => ({
        offset: note.start - start,
        duration: note.duration,
        pitch: note.pitch,
        lyric: note.lyric,
        type: note.type,
      })),
    ),
    // The break after each copied line but the last.
    breaks: lines.slice(0, -1).flatMap((line) => {
      const after = breaks.find((item) => item.lineId === line.id);
      return after ? [after.time - start] : [];
    }),
    text: lines.map((line) => lineText(line.notes)).join("\n"),
    startsLine: lines[0]!.notes[0] === lines[0]!.all[0],
    endsLine: lines.at(-1)!.notes.at(-1) === lines.at(-1)!.all.at(-1),
  };
}

/**
 * Pastes a clip's notes for the singer from `at` (on the grid), as one edit, keeping the line rules: the singer's breaks
 * are theirs plus the clip's (any that would be inside a note moving to the nearer edge of the notes there), every note
 * goes to the line it starts in, lines left without notes go, and switches are stored where they had to move. Notes
 * past the song's end are cut short there or left out. Returns the new notes' ids (none when nothing fits).
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
  const existing = lines.flatMap((line) => line.notes.map((note) => ({ ...note, lineId: line.id })));
  const spans = occupied([...existing, ...pasted]);
  /** Out of any note: the nearer edge of the notes there. */
  const outside = (time: number) => {
    const span = spanAt(spans, time);
    if (!span) return time;
    return time - span.start <= span.end - time ? span.start : span.end;
  };

  // The breaks: each line's end (its stored switch, or none: the default), then the clip's.
  const drawn = new Map(lineBreaks(chart).map((item) => [item.lineId, item.time]));
  const breaks = [
    ...lines.slice(0, -1).map((line) => {
      const time = drawn.get(line.id) ?? 0;
      const moved = outside(time);
      // A default switch stays default unless a pasted note now covers it.
      return { time: moved, stored: line.switchStart !== null || Math.abs(moved - time) > EPSILON };
    }),
    ...clip.breaks.map((offset) => ({ time: outside(onGrid(chart, at + offset)), stored: true })),
    // Whole lines are their own lines (a break there with nothing on one side goes again below).
    ...(clip.startsLine ? [{ time: outside(pasted[0]!.start), stored: true }] : []),
    ...(clip.endsLine
      ? [{ time: outside(Math.max(...pasted.map((note) => note.start + note.duration))), stored: true }]
      : []),
  ].toSorted((a, b) => a.time - b.time);

  // Every note into the stretch between breaks it starts in; stretches without notes go (with the break before them).
  type Placed =
    | { start: number; existing: (typeof existing)[number] }
    | { start: number; pasted: number; existing?: undefined };
  const all: Placed[] = [
    ...existing.map((note) => ({ start: note.start, existing: note })),
    ...pasted.map((note, index) => ({ start: note.start, pasted: index })),
  ].toSorted((a, x) => a.start - x.start);
  const groups: { notes: Placed[]; end: { time: number; stored: boolean } | null }[] = [];
  let group: Placed[] = [];
  let next = 0;
  for (const note of all) {
    while (next < breaks.length && note.start >= breaks[next]!.time - EPSILON) {
      if (group.length > 0) groups.push({ notes: group, end: breaks[next]! });
      group = [];
      next++;
    }
    group.push(note);
  }
  groups.push({ notes: group, end: null });

  // Each stretch keeps the line most of its notes were in (each line once), else gets a new one (made before its
  // notes).
  const kept = new Set<number>();
  const lineIds = groups.map(({ notes }) => {
    const counts = new Map<number, number>();
    for (const note of notes) {
      if (note.existing) counts.set(note.existing.lineId, (counts.get(note.existing.lineId) ?? 0) + 1);
    }
    const best = [...counts].filter(([id]) => !kept.has(id)).toSorted((x, y) => y[1] - x[1])[0]?.[0];
    if (best === undefined) return tx.createLine({ singerId: singer.id, switchStart: null, switchEnd: null });
    kept.add(best);
    return best;
  });

  const created: number[] = [];
  groups.forEach(({ notes, end: after }, g) => {
    const lineId = lineIds[g]!;
    for (const note of notes) {
      if (note.existing) {
        // Changing line isn't changing the note: it keeps its `edited`.
        if (note.existing.lineId !== lineId) tx.updateNote(note.existing.id, { lineId, edited: note.existing.edited });
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
    // Where the next line appears: a break that is stored (or had to move) keeps its time, a default one stays default;
    // the last line keeps what the singer's last line had.
    const switchStart = after ? (after.stored ? after.time : null) : (lines.at(-1)?.switchStart ?? null);
    tx.updateLine(lineId, { switchStart, switchEnd: null });
  });
  // Lines whose notes all went elsewhere go, after their notes moved.
  for (const line of lines) if (!kept.has(line.id)) tx.deleteLine(line.id);
  return created;
}
