/**
 * The learned corrections after GAME: per-note features for the pitch corrector (notefix) and the note-end
 * regressor (ends), and applying their predictions. A port of the auto-tuner PoC's `notefix.features` /
 * `notefix.apply`, `merge.features` and `ends.apply`; the models themselves (ONNX) run in the native addon.
 *
 * The pitch track is float32 in the PoC and NumPy computes its statistics in float32; the features are the
 * same numbers the PoC computes, and become float32 when they go to the models.
 */
import { toBeat, type Grid } from "./grid";
import type { Note, TraceEntry } from "./notes";
import { floorMod, mean32, median32, pyRound, std32 } from "./numpy";

/** The pitch corrector's classes: semitones to shift a note by. */
export const PITCH_SHIFTS = [-2, -1, 0, 1, 2];
/** A note shifts when its most likely shift (other than 0) has at least this probability. */
export const SHIFT_THRESHOLD = 0.5;

export interface PitchTrack {
  /** Seconds of each frame. */
  times: Float64Array;
  /** MIDI pitch per frame (NaN where unvoiced), float32 like the PoC's. */
  midi: Float32Array;
}

/** Pitch-class difference in [-6, 6). */
const fold = (x: number) => floorMod(x + 6, 12) - 6;
/** `fold` on a float32 array element, kept in float32 as NumPy does. */
const fold32 = (x: number) => Math.fround(Math.fround(floorMod(Math.fround(x + 6), 12)) - 6);

const clip = (x: number) => Math.min(12, Math.max(-12, x));

/** numpy.searchsorted(sorted, value), left side. */
function searchsorted(sorted: Float64Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * `np.percentile(x, [..])` of a float32 array with a list of quantiles: unlike a single Python number, the weights
 * are a float64 array, so NumPy interpolates in float64 (with b − a still float32).
 */
function percentiles32(values: Float32Array, qs: readonly number[]): number[] {
  const sorted = Float64Array.from(values).toSorted();
  const n = sorted.length;
  return qs.map((q) => {
    const index = (n - 1) * (q / 100);
    const lo = Math.floor(index);
    const hi = Math.min(lo + 1, n - 1);
    const t = index - lo;
    const a = sorted[lo]!;
    const b = sorted[hi]!;
    const diff = Math.fround(b - a);
    return t >= 0.5 ? b - diff * (1 - t) : a + diff * t;
  });
}

/** The 24 notefix features of each note (notefix.FEATURES order). */
export function noteFeatures(
  notes: readonly Note[],
  trace: readonly TraceEntry[],
  track: PitchTrack,
  tuning: number,
  scale: readonly number[] | null,
): number[][] {
  const shift = Math.fround(tuning);
  return notes.map((note, i) => {
    const tr = trace[i]!;
    const p = note.pitch + 60;
    const frames = track.midi.subarray(searchsorted(track.times, tr.start), searchsorted(track.times, tr.end));
    const v = Float32Array.from(
      Array.from(frames).filter((m) => !Number.isNaN(m)),
      (m) => Math.fround(m - shift),
    );
    let stats: number[];
    if (v.length) {
      const rel = v.map((x) => fold32(Math.fround(x - p)));
      const third = Math.max(1, Math.floor(v.length / 3));
      stats = [
        median32(rel),
        mean32(rel),
        ...percentiles32(rel, [10, 25, 75, 90]),
        std32(rel),
        median32(rel.subarray(0, third)),
        median32(v.length > 1 ? rel.subarray(third) : rel),
        v.length / Math.max(frames.length, 1),
      ];
    } else {
      stats = Array.from({ length: 10 }, () => 0);
    }
    const inScale = [-2, -1, 0, 1, 2].map((d) => (scale !== null && scale.includes(floorMod(p + d, 12)) ? 1 : 0));
    const prevStep = i ? clip(p - (notes[i - 1]!.pitch + 60)) : 0;
    const nextStep = i + 1 < notes.length ? clip(notes[i + 1]!.pitch + 60 - p) : 0;
    return [
      fold(tr.raw - p),
      fold(tr.raw - tuning - pyRound(tr.raw - tuning)),
      tuning,
      tr.end - tr.start,
      tr.part,
      tr.parts,
      tr.parts === 0 ? 1 : 0,
      ...inScale,
      ...stats,
      prevStep,
      nextStep,
    ];
  });
}

/** Rows of features as the float32 matrix the models take. */
export function featureMatrix(rows: readonly number[][]): Float32Array {
  return Float32Array.from(rows.flat());
}

/** Shift each note by the corrector's most likely shift when that isn't 0 and is likely enough (in place). */
export function applyPitchShifts(notes: Note[], probabilities: Float32Array, threshold = SHIFT_THRESHOLD): void {
  const classes = PITCH_SHIFTS.length;
  notes.forEach((note, i) => {
    let best = 0;
    for (let k = 1; k < classes; k++)
      if (probabilities[i * classes + k]! > probabilities[i * classes + best]!) best = k;
    if (PITCH_SHIFTS[best] !== 0 && probabilities[i * classes + best]! >= threshold) note.pitch += PITCH_SHIFTS[best]!;
  });
}

/** The 27 note-end features: notefix's (recomputed after the pitch shifts) plus the gaps to the neighbours. */
export function endFeatures(base: readonly number[][], trace: readonly TraceEntry[]): number[][] {
  return base.map((features, i) => {
    const gapPrevious = i ? trace[i]!.start - trace[i - 1]!.end : 1.0;
    const previousLength = i ? trace[i - 1]!.end - trace[i - 1]!.start : 0.0;
    const gapNext = i + 1 < trace.length ? trace[i + 1]!.start - trace[i]!.end : 1.0;
    return [...features, Math.min(gapPrevious, 1.0), previousLength, Math.min(gapNext, 1.0)];
  });
}

/**
 * Move note ends by the predicted seconds (in place): at least one beat long, and not past the next note, keeping
 * `gapUnits` before a new syllable.
 */
export function applyEnds(
  notes: Note[],
  trace: readonly TraceEntry[],
  deltas: Float32Array,
  grid: Grid,
  gapUnits = 1,
): void {
  notes.forEach((note, i) => {
    let end = toBeat(grid, trace[i]!.end + deltas[i]!);
    const next = notes[i + 1];
    if (next) end = Math.min(end, next.start - (["~", ""].includes(next.text.trim()) ? 0 : gapUnits));
    note.length = Math.max(1, end - note.start);
  });
}
