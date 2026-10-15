/**
 * The chart's beat grid: one constant tempo fitted to the tracked beats (UltraStar has a single BPM), and the
 * UltraStar grid built on it. A port of the auto-tuner PoC's `beats.Beats.fit_grid` and `chart.make_grid` /
 * `chart.Grid`, reproducing NumPy's arithmetic so the same beats give the same BPM.
 */
import { arange, argmax, complexMean, median, pyRound } from "./numpy";

const TWO_PI = 2 * Math.PI;

/** |mean(exp(2πi·t/half))| for each tempo: how well all beats sit on that tempo's half-beat grid. */
function coherence(beats: Float64Array, bpms: Float64Array): Float64Array {
  const out = new Float64Array(bpms.length);
  const terms = new Float64Array(beats.length * 2);
  bpms.forEach((bpm, k) => {
    const half = 30 / bpm;
    beats.forEach((t, i) => {
      // NumPy: (2j·π)·t is (0, 2π·t); its complex division by `half` multiplies by 1 / half.
      const x = TWO_PI * t * (1 / half);
      terms[2 * i] = Math.cos(x);
      terms[2 * i + 1] = Math.sin(x);
    });
    const [re, im] = complexMean(terms);
    out[k] = Math.hypot(re, im);
  });
  return out;
}

export interface FittedTempo {
  bpm: number;
  /** Time of beat 0 in seconds. */
  t0: number;
  /** Median distance of the tracked beats from the grid, in seconds. */
  residual: number;
}

/**
 * Fit one tempo between `lo` and `hi` BPM. The tracker flips between a tempo and its double, so instead of averaging
 * intervals this scans candidate tempos for the one whose half-beat grid *all* beats sit on (phase coherence),
 * first in steps of 0.05, then 0.001 around the best. Beat 0 goes on the full-beat grid point closest to the
 * first downbeat (or the first beat).
 */
export function fitGrid(beats: Float64Array, downbeats: Float64Array, lo = 80, hi = 160): FittedTempo {
  const coarse = arange(lo, hi, 0.05);
  const best = coarse[argmax(coherence(beats, coarse))]!;
  const fine = arange(best - 0.1, best + 0.1, 0.001);
  const bpm = fine[argmax(coherence(beats, fine))]!;
  const half = 30 / bpm;
  const terms = new Float64Array(beats.length * 2);
  beats.forEach((t, i) => {
    const x = TWO_PI * t * (1 / half);
    terms[2 * i] = Math.cos(x);
    terms[2 * i + 1] = Math.sin(x);
  });
  const [re, im] = complexMean(terms);
  const phase = (Math.atan2(im, re) / TWO_PI) * half;
  const anchor = downbeats.length ? downbeats[0]! : beats[0]!;
  const t0 = phase + pyRound((anchor - phase) / half) * half;
  const residual = median(beats.map((t) => Math.abs(t - t0 - pyRound((t - t0) / half) * half)));
  return { bpm, t0, residual };
}

/** An UltraStar grid: `bpm` is the #BPM (4 grid units per quarter of it), `gap` the time of grid beat 0. */
export interface Grid {
  bpm: number;
  gap: number;
}

/** Seconds per UltraStar beat. */
export function unit(grid: Grid): number {
  return 60 / (grid.bpm * 4);
}

/** The UltraStar beat nearest to `t` seconds (halves to even, like the PoC). */
export function toBeat(grid: Grid, t: number): number {
  return pyRound((t - grid.gap) / unit(grid));
}

export function toSec(grid: Grid, beat: number): number {
  return grid.gap + beat * unit(grid);
}

/**
 * The UltraStar grid for a fitted tempo, with beat 0 on the real beat just before the first note. 16 UltraStar beats
 * per real beat (#BPM = 4× the real tempo), what most USDB charts use.
 */
export function makeGrid(bpm: number, t0: number, firstNote: number, unitsPerBeat = 16): Grid {
  const beat = 60 / bpm;
  const gap = t0 + Math.floor((firstNote - t0) / beat) * beat;
  return { bpm: (bpm * unitsPerBeat) / 4, gap };
}
