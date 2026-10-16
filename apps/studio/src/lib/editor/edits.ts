/**
 * Editing notes: what the selection can do and how far it can go, without Solid or the document. Notes keep to the
 * grid (a step is 15 / #BPM seconds from #GAP) and the song, and stay in their line's room: up to its stored break,
 * or without one, up to the next line's first note (lines never interleave; they change by moving the breaks). They
 * may overlap while editing (pasting a section over others is easier that way); `overlapping` finds them, to show as a
 * problem. The edits record through an `EditRecorder`.
 */
import type { EditorChart, EditorNote, NoteType } from "~/lib/native/types";

import { defaultSwitch } from "./chart";
import type { EditRecorder } from "./document";

/** Times closer than this are the same (seconds, against float rounding). */
const EPSILON = 1e-6;

/** The highest pitch a note can have (MIDI). */
const HIGHEST_PITCH = 127;

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

/**
 * The room each line has (by id): from the line before it (its stored break, else the end of its notes; 0 for the
 * first) to the line after it (this line's stored break, else the next line's first note; the song's end for the
 * last).
 */
export function lineRooms(chart: EditorChart, length: number): Map<number, { before: number; after: number }> {
  const rooms = new Map<number, { before: number; after: number }>();
  for (const singer of chart.singers) {
    const lines = singer.lines.filter((line) => line.notes.length > 0);
    const end = (line: (typeof lines)[number]) =>
      line.switchStart ?? Math.max(...line.notes.map((note) => note.start + note.duration));
    lines.forEach((line, l) => {
      const previous = lines[l - 1];
      const next = lines[l + 1];
      rooms.set(line.id, {
        before: previous ? end(previous) : 0,
        after: next ? (line.switchStart ?? Math.min(...next.notes.map((note) => note.start))) : length,
      });
    });
    for (const line of singer.lines) if (!rooms.has(line.id)) rooms.set(line.id, { before: 0, after: length });
  }
  return rooms;
}

/** A note with the room its line has (`lineRooms`). */
interface Placed extends EditorNote {
  singerId: number;
  lineId: number;
  before: number;
  after: number;
}

/** Every note with its line's room. */
export function placeNotes(chart: EditorChart, length: number): Map<number, Placed> {
  const rooms = lineRooms(chart, length);
  const placed = new Map<number, Placed>();
  for (const singer of chart.singers) {
    for (const line of singer.lines) {
      const room = rooms.get(line.id)!;
      for (const note of line.notes) placed.set(note.id, { ...note, singerId: singer.id, lineId: line.id, ...room });
    }
  }
  return placed;
}

/** How far (seconds) the selected notes can move together: within their lines' room. */
export function moveLimits(placed: Map<number, Placed>, ids: ReadonlySet<number>) {
  let min = -Infinity;
  let max = Infinity;
  for (const id of ids) {
    const note = placed.get(id);
    if (!note) continue;
    min = Math.max(min, note.before - note.start);
    max = Math.min(max, note.after - (note.start + note.duration));
  }
  return { min, max };
}

/** How far (seconds) the selected notes' ends can move: down to one step long, up to a stored break or the end. */
export function lengthLimits(placed: Map<number, Placed>, ids: ReadonlySet<number>, step: number) {
  let min = -Infinity;
  let max = Infinity;
  for (const id of ids) {
    const note = placed.get(id);
    if (!note) continue;
    min = Math.max(min, Math.min(0, step - note.duration));
    max = Math.min(max, note.after - (note.start + note.duration));
  }
  return { min, max };
}

/** How far (seconds) the selected notes' starts can move, their ends staying: from a stored break or 0, to a step long. */
export function startLimits(placed: Map<number, Placed>, ids: ReadonlySet<number>, step: number) {
  let min = -Infinity;
  let max = Infinity;
  for (const id of ids) {
    const note = placed.get(id);
    if (!note) continue;
    min = Math.max(min, note.before - note.start);
    max = Math.min(max, Math.max(0, note.duration - step));
  }
  return { min, max };
}

/** How many semitones the selected notes can go down (`min`, negative) and up (`max`) and stay in MIDI's range. */
export function pitchLimits(chart: EditorChart, ids: ReadonlySet<number>) {
  let min = -Infinity;
  let max = Infinity;
  for (const singer of chart.singers) {
    for (const line of singer.lines) {
      for (const note of line.notes) {
        if (!ids.has(note.id)) continue;
        min = Math.max(min, -note.pitch);
        max = Math.min(max, HIGHEST_PITCH - note.pitch);
      }
    }
  }
  return { min, max };
}

/**
 * A drag's raw change as whole `unit`s (grid steps, semitones) within `limits`: the nearest that fits, or 0 when
 * none does.
 */
export function snapDelta(raw: number, unit: number, limits: { min: number; max: number }): number {
  const low = Math.ceil(limits.min / unit - EPSILON);
  const high = Math.floor(limits.max / unit + EPSILON);
  if (low > high) return 0;
  return Math.min(high, Math.max(low, Math.round(raw / unit))) * unit;
}

/** Whether `delta` fits `limits` (with float slack). */
export const fits = (delta: number, limits: { min: number; max: number }) =>
  delta >= limits.min - EPSILON && delta <= limits.max + EPSILON;

/** Moves the notes by `delta` seconds (kept on the grid). */
export function moveNotes(tx: EditRecorder, chart: EditorChart, ids: Iterable<number>, delta: number) {
  for (const id of ids) {
    const note = tx.note(id);
    if (note) tx.updateNote(id, { start: onGrid(chart, note.start + delta) });
  }
}

/** Changes the notes' length by `delta` seconds (their ends kept on the grid). */
export function resizeNotes(tx: EditRecorder, chart: EditorChart, ids: Iterable<number>, delta: number) {
  for (const id of ids) {
    const note = tx.note(id);
    if (note) tx.updateNote(id, { duration: onGrid(chart, note.start + note.duration + delta) - note.start });
  }
}

/** Moves the notes' starts by `delta` seconds, their ends staying (both kept on the grid). */
export function resizeStarts(tx: EditRecorder, chart: EditorChart, ids: Iterable<number>, delta: number) {
  for (const id of ids) {
    const note = tx.note(id);
    if (!note) continue;
    const start = onGrid(chart, note.start + delta);
    tx.updateNote(id, { start, duration: onGrid(chart, note.start + note.duration) - start });
  }
}

/** Whether the notes can all go `semitones` up (or down) and stay in MIDI's range. */
export function pitchFits(chart: EditorChart, ids: ReadonlySet<number>, semitones: number): boolean {
  return chart.singers.every((singer) =>
    singer.lines.every((line) =>
      line.notes.every(
        (note) => !ids.has(note.id) || (note.pitch + semitones >= 0 && note.pitch + semitones <= HIGHEST_PITCH),
      ),
    ),
  );
}

export function shiftPitch(tx: EditRecorder, ids: Iterable<number>, semitones: number) {
  for (const id of ids) {
    const note = tx.note(id);
    if (note) tx.updateNote(id, { pitch: note.pitch + semitones });
  }
}

/** Deletes the notes, and the lines that are left without any. */
export function deleteNotes(tx: EditRecorder, chart: EditorChart, ids: ReadonlySet<number>) {
  for (const singer of chart.singers) {
    for (const line of singer.lines) {
      const doomed = line.notes.filter((note) => ids.has(note.id));
      for (const note of doomed) tx.deleteNote(note.id);
      if (doomed.length > 0 && doomed.length === line.notes.length) tx.deleteLine(line.id);
    }
  }
}

/**
 * Merges notes next to each other in one line into the first: it reaches to the end of the last, and the later
 * syllables join its own without their `~` (a held vowel is part of the syllable it holds). Returns the merged note,
 * or null when the notes aren't next to each other in one line.
 */
export function mergeNotes(tx: EditRecorder, chart: EditorChart, ids: ReadonlySet<number>): number | null {
  const run = mergeRun(chart, ids);
  if (!run) return null;
  const [head, ...rest] = run;
  const last = run.at(-1)!;
  tx.updateNote(head!.id, {
    duration: last.start + last.duration - head!.start,
    lyric: head!.lyric + rest.map((note) => note.lyric.replaceAll("~", "")).join(""),
  });
  for (const note of rest) tx.deleteNote(note.id);
  return head!.id;
}

/** Whether the notes can be merged: two or more next to each other in one line. */
export function canMerge(chart: EditorChart, ids: ReadonlySet<number>): boolean {
  return mergeRun(chart, ids) !== null;
}

/** The notes in their line's order when they are two or more next to each other in one line, else null. */
function mergeRun(chart: EditorChart, ids: ReadonlySet<number>) {
  if (ids.size < 2) return null;
  for (const singer of chart.singers) {
    for (const line of singer.lines) {
      const first = line.notes.findIndex((note) => ids.has(note.id));
      if (first < 0) continue;
      const run = line.notes.slice(first, first + ids.size);
      return run.length === ids.size && run.every((note) => ids.has(note.id)) ? run : null;
    }
  }
  return null;
}

/** What a note type is made of: golden, rap, or freestyle (which is neither). */
const FLAGS: Record<NoteType, { golden: boolean; rap: boolean; freestyle: boolean }> = {
  normal: { golden: false, rap: false, freestyle: false },
  golden: { golden: true, rap: false, freestyle: false },
  rap: { golden: false, rap: true, freestyle: false },
  "golden-rap": { golden: true, rap: true, freestyle: false },
  freestyle: { golden: false, rap: false, freestyle: true },
};

function typeOf(flags: { golden: boolean; rap: boolean; freestyle: boolean }): NoteType {
  if (flags.freestyle) return "freestyle";
  if (flags.golden) return flags.rap ? "golden-rap" : "golden";
  return flags.rap ? "rap" : "normal";
}

/** The kinds a key toggles: golden (G), rap (R), freestyle (F). */
export type NoteFlag = "golden" | "rap" | "freestyle";

/** The note types a note can be toggled to, with their names and keys (the keys and the note menu use these). */
export const NOTE_FLAGS: readonly { flag: NoteFlag; label: string; key: string }[] = [
  { flag: "golden", label: "Golden", key: "G" },
  { flag: "rap", label: "Rap", key: "R" },
  { flag: "freestyle", label: "Freestyle", key: "F" },
];

/**
 * Turns `flag` on for the notes, or off when all of them have it already. Golden and rap combine (golden rap);
 * freestyle is neither.
 */
export function toggleFlag(tx: EditRecorder, chart: EditorChart, ids: ReadonlySet<number>, flag: NoteFlag) {
  const notes = chart.singers.flatMap((singer) =>
    singer.lines.flatMap((line) => line.notes.filter((note) => ids.has(note.id))),
  );
  const on = !notes.every((note) => FLAGS[note.type][flag]);
  for (const note of notes) {
    const flags = { ...FLAGS[note.type], [flag]: on };
    if (on && flag === "freestyle") Object.assign(flags, { golden: false, rap: false });
    if (on && flag !== "freestyle") flags.freestyle = false;
    tx.updateNote(note.id, { type: typeOf(flags) });
  }
}

/** Whether a note of `type` has `flag` (golden rap has both). */
export function hasFlag(type: NoteType, flag: NoteFlag): boolean {
  return FLAGS[type][flag];
}

/** The notes that overlap another note of the same singer (a problem to fix before export). */
export function overlapping(chart: EditorChart): Set<number> {
  const found = new Set<number>();
  for (const singer of chart.singers) {
    const notes = singer.lines.flatMap((line) => line.notes).toSorted((a, b) => a.start - b.start);
    let reach: { end: number; id: number } | null = null;
    for (const note of notes) {
      if (reach && note.start < reach.end - EPSILON) {
        found.add(note.id);
        found.add(reach.id);
      }
      const end = note.start + note.duration;
      if (!reach || end > reach.end) reach = { end, id: note.id };
    }
  }
  return found;
}

/** How long a note added with a click is at first: about an eighth of a second (a short syllable), in whole steps. */
export function defaultLength(chart: EditorChart): number {
  const step = gridStep(chart);
  return Math.max(1, Math.round(0.125 / step)) * step;
}

/**
 * The line of a singer's that `time` falls in: lines reach from one line break (stored, or the default) to the next,
 * so a time before the first is in the first and one after the last in the last. Null without lines.
 */
export function lineAt(chart: EditorChart, singerId: number, time: number): number | null {
  const lines = chart.singers.find((singer) => singer.id === singerId)?.lines.filter((line) => line.notes.length > 0);
  if (!lines?.length) return null;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    const last = line.notes.at(-1)!;
    const gapStart = last.start + last.duration;
    const gapEnd = Math.max(gapStart, lines[i + 1]!.notes[0]!.start);
    if (time < (line.switchStart ?? defaultSwitch(gapStart, gapEnd))) return line.id;
  }
  return lines.at(-1)!.id;
}

/**
 * Adds a note without a syllable yet to the singer's line at its start (or a first line when the singer has none):
 * on the grid, inside that line's room and the song, cut short where it would reach past them. Returns its id, or
 * null when not even a step fits there.
 */
export function addNote(
  tx: EditRecorder,
  chart: EditorChart,
  note: { singerId: number; start: number; duration: number; pitch: number },
  length: number,
): number | null {
  const step = gridStep(chart);
  const existing = lineAt(chart, note.singerId, note.start);
  const room = (existing === null ? undefined : lineRooms(chart, length).get(existing)) ?? { before: 0, after: length };
  const start = Math.max(gridCeil(chart, room.before), onGrid(chart, note.start));
  const end = Math.min(gridFloor(chart, room.after), Math.max(start + step, onGrid(chart, start + note.duration)));
  if (end - start < step - EPSILON) return null;
  const lineId =
    existing ??
    chart.singers.find((singer) => singer.id === note.singerId)?.lines[0]?.id ??
    tx.createLine({ singerId: note.singerId, switchStart: null, switchEnd: null });
  return tx.createNote({ lineId, start, duration: end - start, pitch: note.pitch, lyric: "", type: "normal" });
}

/**
 * Splits a note at `time` (on the grid, a step or more from either end): the first part keeps the syllable, the second
 * holds it (`~`). Returns the second part, or null when the note is too short to split there.
 */
export function splitNote(tx: EditRecorder, chart: EditorChart, id: number, time: number): number | null {
  const note = tx.note(id);
  if (!note) return null;
  const step = gridStep(chart);
  const at = onGrid(chart, time);
  const end = note.start + note.duration;
  if (at < note.start + step - EPSILON || at > end - step + EPSILON) return null;
  tx.updateNote(id, { duration: at - note.start });
  return tx.createNote({
    lineId: note.lineId,
    start: at,
    duration: onGrid(chart, end) - at,
    pitch: note.pitch,
    lyric: "~",
    type: note.type,
  });
}

/** Whether a split at `time` (put on the grid) leaves a step or more either side of it. */
export function canSplit(chart: EditorChart, note: { start: number; duration: number }, time: number): boolean {
  const step = gridStep(chart);
  const at = onGrid(chart, time);
  return at >= note.start + step - EPSILON && at <= note.start + note.duration - step + EPSILON;
}
