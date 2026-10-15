import { breaksLine, createId, NOTE_TYPE_SYMBOLS, type ChartNote, type NoteType } from "./types";

function assertNote(note: ChartNote): void {
  if (
    !note ||
    !Number.isFinite(note.start) ||
    !Number.isFinite(note.duration) ||
    note.duration <= 0 ||
    !Number.isFinite(note.start + note.duration) ||
    note.start + note.duration === note.start
  ) {
    throw new RangeError("Note must have finite timing and a positive, representable duration.");
  }
  if (!Number.isSafeInteger(note.pitch) || !Number.isSafeInteger(note.pitch - 60))
    throw new RangeError("Note pitch must be a safe integer in MIDI semitones.");
  if (typeof note.lyric !== "string" || breaksLine(note.lyric))
    throw new RangeError("Note lyric must be a single-line string.");
  if (typeof note.id !== "string" || !note.id.trim() || typeof note.lineId !== "string" || !note.lineId.trim())
    throw new RangeError("Note and line IDs must be non-empty strings.");
  if (typeof note.type !== "string" || !Object.prototype.hasOwnProperty.call(NOTE_TYPE_SYMBOLS, note.type))
    throw new RangeError("Unsupported note type.");
  if (note.player !== undefined && note.player !== 1 && note.player !== 2)
    throw new RangeError("Only player tracks 1 and 2 are supported.");
}

export interface SplitNoteOptions {
  /** Split the lyric at this Unicode code-point offset. Default: left keeps lyric, right is '~'. */
  lyricOffset?: number;
  /** Supply a deterministic new ID for command/history systems. Must differ from the original. */
  rightId?: string;
}

/** Left half retains the original ID; both halves retain line/player/type/pitch. */
export function splitNote(note: ChartNote, atSeconds: number, options: SplitNoteOptions = {}): [ChartNote, ChartNote] {
  assertNote(note);
  const end = note.start + note.duration;
  if (!Number.isFinite(atSeconds) || atSeconds <= note.start || atSeconds >= end)
    throw new RangeError("Split time must be strictly inside the note.");
  const rightId = options.rightId ?? createId("note");
  if (!rightId.trim() || rightId === note.id)
    throw new RangeError("Right-half ID must be non-empty and differ from the original ID.");
  let leftLyric = note.lyric;
  let rightLyric = "~";
  if (options.lyricOffset !== undefined) {
    const characters = Array.from(note.lyric);
    if (!Number.isInteger(options.lyricOffset) || options.lyricOffset < 0 || options.lyricOffset > characters.length)
      throw new RangeError("Lyric split offset is outside the syllable.");
    leftLyric = characters.slice(0, options.lyricOffset).join("");
    rightLyric = characters.slice(options.lyricOffset).join("");
  }
  return [
    { ...note, duration: atSeconds - note.start, lyric: leftLyric },
    { ...note, id: rightId, start: atSeconds, duration: end - atSeconds, lyric: rightLyric },
  ];
}

export interface MergeNotesOptions {
  /** Explicit overrides are required to merge differing pitches/types. */
  pitch?: number;
  type?: NoteType;
  lyric?: string;
  /** False by default: filling a real rest must be intentional. */
  allowGaps?: boolean;
}

/** Earliest note's ID survives. Exact lyric strings are concatenated without invented spaces. */
export function mergeNotes(notes: readonly ChartNote[], options: MergeNotesOptions = {}): ChartNote {
  if (!notes.length) throw new RangeError("Select at least one note to merge.");
  notes.forEach(assertNote);
  if (new Set(notes.map((note) => note.id)).size !== notes.length)
    throw new RangeError("Cannot merge duplicate note IDs.");
  const sorted = notes.toSorted((a, b) => a.start - b.start);
  const first = sorted[0]!;
  let end = first.start + first.duration;
  for (const note of sorted) {
    if (note.lineId !== first.lineId || (note.player ?? 1) !== (first.player ?? 1))
      throw new RangeError("Merged notes must belong to the same lyric line and player.");
    if (options.pitch === undefined && note.pitch !== first.pitch)
      throw new RangeError("Notes have different pitches; provide an explicit merge pitch.");
    if (options.type === undefined && note.type !== first.type)
      throw new RangeError("Notes have different types; provide an explicit merge type.");
    if (!options.allowGaps && note.start > end + 1e-8)
      throw new RangeError("Notes contain a rest; set allowGaps to merge across it.");
    end = Math.max(end, note.start + note.duration);
  }
  const merged: ChartNote = {
    ...first,
    duration: end - first.start,
    pitch: options.pitch ?? first.pitch,
    type: options.type ?? first.type,
    lyric: options.lyric ?? sorted.map((note) => note.lyric).join(""),
  };
  assertNote(merged);
  return merged;
}

/** Returns a new array; unselected notes may share identity. Never clamps pitches silently. */
export function transposeNotes(
  notes: readonly ChartNote[],
  semitones: number,
  selectedIds?: ReadonlySet<string>,
): ChartNote[] {
  if (!Number.isSafeInteger(semitones)) throw new RangeError("Transposition must be a whole number of semitones.");
  return notes.map((note) => {
    if (selectedIds && !selectedIds.has(note.id)) return note;
    assertNote(note);
    const pitch = note.pitch + semitones;
    if (!Number.isSafeInteger(pitch) || !Number.isSafeInteger(pitch - 60))
      throw new RangeError("Transposed pitch exceeds the safe integer range.");
    return { ...note, pitch };
  });
}
