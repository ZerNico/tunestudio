/**
 * Notes for a line: aligned words split into syllable spans, GAME run on the line's audio with the syllable starts
 * as known boundaries, and GAME's raw notes turned into UltraStar notes on the grid. A port of the auto-tuner PoC's
 * `chart.syllable_spans` and `chart.notes_for_line_game`; GAME itself runs in the native addon.
 */
import type { NoteType } from "@tunestudio/ultrastar";

import { timeAt, type WordTiming } from "./align";
import { toBeat, type Grid } from "./grid";
import { pyRound } from "./numpy";
import { snap } from "./scale";

/** One syllable's aligned time span. `text` ends with a space when it ends a word. */
export interface SyllableSpan {
  text: string;
  start: number;
  /** Hard limit: the next syllable's start. */
  end: number;
  score: number;
}

/** A note as UltraStar has it: beats on the grid, pitch in semitones from C4 (MIDI 60). */
export interface Note {
  type: NoteType;
  start: number;
  length: number;
  pitch: number;
  text: string;
}

/** A GAME note, seconds relative to the audio GAME got. */
export interface GameNote {
  start: number;
  end: number;
  voiced: boolean;
  midi: number;
}

/** What GAME saw for each note: its seconds and raw pitch, for the learned pitch and end corrections. */
export interface TraceEntry {
  start: number;
  end: number;
  raw: number;
  syl: number;
  part: number;
  parts: number;
}

/** Python's `len()`: code points. */
const length = (text: string) => [...text].length;

/**
 * Split aligned words into syllables using the per-character timing. A syllable lasts until the next one starts,
 * but no more than `maxTail` past its word's aligned end (a next word misaligned far away would be swallowed).
 */
export function syllableSpans(
  words: readonly WordTiming[],
  syllables: readonly string[][],
  nextLineStart: number | null,
  maxTail = 1.5,
): SyllableSpan[] {
  const spans: SyllableSpan[] = [];
  const wordEnds: number[] = [];
  words.forEach((word, w) => {
    const syls = syllables[w]!;
    const total = syls.reduce((n, s) => n + length(s), 0);
    let position = 0;
    syls.forEach((syl, si) => {
      const start = si ? timeAt(word, position / total) : word.start;
      position += length(syl);
      spans.push({ text: syl + (si === syls.length - 1 ? " " : ""), start, end: 0, score: word.score });
      wordEnds.push(word.end);
    });
  });
  spans.forEach((span, i) => {
    const next = i + 1 < spans.length ? spans[i + 1]!.start : (nextLineStart ?? Infinity);
    span.end = Math.min(next, Math.max(wordEnds[i]!, span.start) + maxTail);
  });
  return spans;
}

/** The audio GAME gets for a line and the regions whose boundaries it must keep. */
export interface GameRequest {
  /** Seconds of the song where the line's audio starts and ends. */
  a: number;
  b: number;
  /** Sample range of that audio. */
  from: number;
  to: number;
  /** Durations (seconds) of the regions between syllable starts, summing to the audio's length. */
  known: number[];
  /** Each syllable's end, no more than `maxSyllable` after its start. */
  ends: number[];
}

/** The GAME request for a line, or null when its audio is too short (under 0.1 s) to get notes from. */
export function gameRequest(
  spans: readonly SyllableSpan[],
  samples: number,
  sr: number,
  pad = 0.2,
  maxSyllable = 3.0,
): GameRequest | null {
  if (!spans.length) return null;
  const ends = spans.map((s) => Math.min(s.end, s.start + maxSyllable));
  const a = Math.max(0, spans[0]!.start - pad);
  const b = Math.min(samples / sr, ends.at(-1)! + pad);
  const cuts = [...new Set([a, ...spans.map((s) => s.start).filter((t) => a < t && t < b), b])].toSorted(
    (x, y) => x - y,
  );
  const known = cuts.slice(1).flatMap((y, i) => (y > cuts[i]! ? [y - cuts[i]!] : []));
  const from = Math.trunc(a * sr);
  const to = Math.trunc(b * sr);
  if (to - from < sr * 0.1) return null;
  return { a, b, from, to, known, ends };
}

export interface LineNoteOptions {
  scale: readonly number[] | null;
  scaleSnap?: number;
  gapUnits?: number;
  maxSyllable?: number;
  /** A syllable owns GAME's notes until the next syllable starts (instead of until its aligned end). */
  claimTails?: boolean;
}

/**
 * UltraStar notes for a line from GAME's raw notes: each syllable takes the voiced notes whose middle lies in its span,
 * neighbours on the same semitone merge, a melisma's notes stay within a fifth of each other, and syllables GAME
 * found nothing in get a short note (the previous pitch, or the line's first sung pitch at its start).
 */
export function notesFromGame(
  spans: readonly SyllableSpan[],
  raw: readonly GameNote[],
  request: GameRequest,
  grid: Grid,
  options: LineNoteOptions,
): { notes: Note[]; trace: TraceEntry[] } {
  const { scale, scaleSnap = 0.35, gapUnits = 1, maxSyllable = 3.0, claimTails = false } = options;
  const { a, b, ends } = request;
  const notes: Note[] = [];
  const trace: TraceEntry[] = [];
  const guessed: number[] = []; // unvoiced syllables at the start of the line: no pitch to copy from yet
  spans.forEach((span, si) => {
    const lo = span.start;
    let hi = ends[si]!;
    if (claimTails) hi = Math.min(si + 1 < spans.length ? spans[si + 1]!.start : b, span.start + maxSyllable);
    const mine = raw.filter((n) => {
      const middle = a + (n.start + n.end) / 2;
      return n.voiced && lo - 0.02 <= middle && middle < hi;
    });
    // Merge neighbours GAME split but that land on the same semitone.
    const merged: [number, number, number][] = [];
    for (const n of mine) {
      const last = merged.at(-1);
      if (last && Math.abs(pyRound(n.midi) - pyRound(last[2])) === 0 && a + n.start - last[1] < 0.05)
        last[1] = a + n.end;
      else merged.push([a + n.start, a + n.end, n.midi]);
    }
    if (!merged.length) {
      if (guessed.length === notes.length) guessed.push(notes.length);
      const pitch = notes.length ? notes.at(-1)!.pitch : 0;
      const start = toBeat(grid, span.start);
      const end = Math.min(hi, span.start + 0.3);
      notes.push({ type: "normal", start, length: Math.max(1, toBeat(grid, end) - start), pitch, text: span.text });
      trace.push({ start: span.start, end, raw: pitch + 60, syl: si, part: 0, parts: 0 });
      return;
    }
    merged.forEach((part, k) => {
      const [s, e] = part;
      let midi = part[2];
      if (k > 0) {
        const previous = merged[k - 1]![2];
        while (midi - previous > 7) midi -= 12;
        while (previous - midi > 7) midi += 12;
        part[2] = midi;
      }
      let start = toBeat(grid, s);
      const last = notes.at(-1);
      if (last && start < last.start + last.length) start = last.start + last.length;
      const noteLength = Math.max(1, toBeat(grid, e) - start);
      let text = k === 0 ? span.text : "~";
      if (k === 0 && merged.length > 1 && span.text.endsWith(" ")) text = span.text.trimEnd();
      if (k === merged.length - 1 && k > 0 && span.text.endsWith(" ")) text = "~ ";
      notes.push({ type: "normal", start, length: noteLength, pitch: snap(midi, scale, scaleSnap) - 60, text });
      trace.push({ start: s, end: e, raw: midi, syl: si, part: k, parts: merged.length });
    });
  });
  // Those got C4 as a placeholder (often far off the melody): take the line's first sung pitch instead.
  if (guessed.length && guessed.length < notes.length) {
    const pitch = notes[guessed.length]!.pitch;
    for (const i of guessed) {
      notes[i]!.pitch = pitch;
      trace[i]!.raw = pitch + 60;
    }
  }
  for (let i = 0; i + 1 < notes.length; i++) {
    const [x, y] = [notes[i]!, notes[i + 1]!];
    if (x.start + x.length > y.start - gapUnits && x.length > gapUnits + 1 && !["~", ""].includes(y.text.trim())) {
      x.length = y.start - x.start - gapUnits;
    }
  }
  return { notes, trace };
}
