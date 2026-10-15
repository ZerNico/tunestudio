/**
 * Moving aligned syllable starts to where charters put them: the boundary head gives, every 20 ms, the probability
 * that a syllable starts there, and each start moves to a peak of it nearby. A port of the auto-tuner PoC's
 * `boundary.assign`.
 */
import { argmax } from "./numpy";

/** The boundary head's frame: one probability every 20 ms. */
export const FRAME = 0.02;

interface Candidate {
  time: number;
  score: number;
  /** Index of the peak, -1 for "stays where it is". */
  peak: number;
}

/**
 * Each start moves to a peak (a local maximum of at least `minProb`) within ±`radius` seconds, or stays; no two starts
 * take the same peak and the order is kept. Maximises the sum of (peak probability − cost · shift / radius) over all
 * starts by dynamic programming over the few candidates per start, so a start only jumps far for a clearly better
 * peak and neighbours don't collapse onto one peak.
 */
export function assign(
  starts: readonly number[],
  probs: Float32Array,
  radius = 0.2,
  minProb = 0.3,
  cost = 1,
): number[] {
  if (!starts.length) return [];
  // NumPy compares the float32 probabilities with the threshold as float32.
  const threshold = Math.fround(minProb);
  const peaks: number[] = [];
  for (let i = 1; i < probs.length - 1; i++) {
    const p = probs[i]!;
    if (p >= threshold && p >= probs[i - 1]! && p > probs[i + 1]!) peaks.push(i);
  }
  const times = peaks.map((i) => i * FRAME);
  const candidates: Candidate[][] = starts.map((t) => {
    const found: Candidate[] = [{ time: t, score: 0, peak: -1 }];
    times.forEach((time, k) => {
      if (Math.abs(time - t) <= radius) {
        found.push({ time, score: probs[peaks[k]!]! - (cost * Math.abs(time - t)) / radius, peak: k });
      }
    });
    return found;
  });

  // Per start and candidate: [best total score, back pointer].
  const best: [number, number][][] = [candidates[0]!.map((c) => [c.score, -1])];
  for (let i = 1; i < starts.length; i++) {
    const previous = candidates[i - 1]!;
    best.push(
      candidates[i]!.map(({ time, score, peak }) => {
        let option: [number, number] = [-Infinity, 0];
        let found = false;
        for (const [j, p] of previous.entries()) {
          if (!(p.time + FRAME <= time && (peak < 0 || p.peak < peak))) continue;
          const total = best[i - 1]![j]![0] + score;
          // Python's max() over (score, j) tuples: on a tie the later j wins.
          if (!found || total > option[0] || (total === option[0] && j > option[1])) option = [total, j];
          found = true;
        }
        return option;
      }),
    );
  }
  let j = argmax(best.at(-1)!.map(([total]) => total));
  if (!Number.isFinite(best.at(-1)![j]![0])) return [...starts];
  const out: number[] = [];
  for (let i = starts.length - 1; i >= 0; i--) {
    out.push(candidates[i]![j]!.time);
    j = best[i]![j]![1];
  }
  return out.toReversed();
}
