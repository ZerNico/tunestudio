/**
 * The song's key and tuning, from the vocal pitch track: the diatonic scale covering most sung time, the global
 * deviation from A440, and rounding a sung pitch to a semitone that prefers that scale. A port of the auto-tuner
 * PoC's `chart.estimate_scale`, `chart.tuning_offset` and `chart._snap`. The pitch track is float32 there, so NumPy
 * computes these in float32; so does this.
 */
import { complexMean32, floorMod, pyRound } from "./numpy";

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const TWO_PI_32 = Math.fround(2 * Math.PI);

/** Global deviation from A440 in semitones: the circular mean of the voiced frames' fractional pitch. */
export function tuningOffset(midi: Float32Array): number {
  const terms: number[] = [];
  for (const m of midi) {
    if (Number.isNaN(m)) continue;
    const x = Math.fround(TWO_PI_32 * m);
    terms.push(Math.fround(Math.cos(x)), Math.fround(Math.sin(x)));
  }
  const [re, im] = complexMean32(terms);
  return Math.fround(Math.fround(Math.atan2(im, re)) / TWO_PI_32);
}

/** The diatonic scale (pitch classes) that covers most sung time; a major key and its relative minor are one set. */
export function estimateScale(midi: Float32Array, tuning: number): number[] {
  const hist = Array.from({ length: 12 }, () => 0);
  const shift = Math.fround(tuning);
  for (const m of midi) {
    if (Number.isNaN(m)) continue;
    hist[floorMod(pyRound(Math.fround(m - shift)), 12)]! += 1;
  }
  let best = 0;
  let bestCount = -1;
  for (let root = 0; root < 12; root++) {
    const count = MAJOR.reduce((n, step) => n + hist[(step + root) % 12]!, 0);
    if (count > bestCount) {
      best = root;
      bestCount = count;
    }
  }
  return MAJOR.map((step) => (step + best) % 12).toSorted((a, b) => a - b);
}

/**
 * Round a pitch to a semitone, preferring the song's scale when it lies between two: `snap` widens the in-scale
 * neighbour's catchment (0 = plain rounding, 0.25 = the in-scale semitone wins up to 0.75 away).
 */
export function snap(midi: number, scale: readonly number[] | null, amount: number): number {
  const nearest = pyRound(midi);
  if (!scale?.length || amount <= 0 || scale.includes(floorMod(nearest, 12))) return nearest;
  const other = nearest + (midi > nearest ? 1 : -1);
  if (scale.includes(floorMod(other, 12)) && Math.abs(midi - other) < 0.5 + amount) return other;
  return nearest;
}
