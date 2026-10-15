import { describe, expect, it } from "vitest";

import { assign } from "./boundary";
import { callsOf, goldenSongs, loadGolden } from "./goldens";
import { fitGrid, makeGrid, toBeat } from "./grid";
import { estimateScale, snap, tuningOffset } from "./scale";

interface Track {
  midi: Float32Array;
}

describe("grid and scale", () => {
  it("fits the tempo whose grid all beats sit on", () => {
    const beats = Float64Array.from({ length: 64 }, (_, i) => 1.25 + (i * 60) / 96);
    const { bpm, t0, residual } = fitGrid(beats, Float64Array.of(1.25));
    expect(bpm).toBeCloseTo(96, 2);
    expect(t0).toBeCloseTo(1.25, 6);
    expect(residual).toBeLessThan(1e-6);
    // 16 grid units per beat; beat 0 on the beat before the first note.
    expect(makeGrid(96, 1.25, 3)).toEqual({ bpm: 384, gap: 2.5 });
    expect(toBeat({ bpm: 384, gap: 0 }, (60 / (384 * 4)) * 2.5)).toBe(2);
  });

  it("prefers the song's scale between two semitones", () => {
    const major = [0, 2, 4, 5, 7, 9, 11];
    expect(snap(61.4, major, 0.35)).toBe(62);
    expect(snap(61.4, major, 0)).toBe(61);
    expect(snap(60.4, major, 0.35)).toBe(60);
  });

  it("estimates the scale from the sung pitches", () => {
    const midi = Float32Array.from([62, 64, 66, 67, 69, 71, 73, 74, Number.NaN]);
    expect(estimateScale(midi, 0)).toEqual([1, 2, 4, 6, 7, 9, 11]);
  });
});

describe.skipIf(!goldenSongs().length)("grid and scale against the PoC", () => {
  for (const song of goldenSongs()) {
    it(song, () => {
      const golden = loadGolden(song);
      const [fit] = callsOf(golden, "Beats.fit_grid");
      const beats = fit!.args[0] as { beats: Float64Array; downbeats: Float64Array };
      const { bpm, t0, residual } = fitGrid(beats.beats, beats.downbeats);
      const [expectedBpm, expectedT0, expectedResidual] = fit!.result as number[];
      expect(bpm).toBe(expectedBpm);
      expect(t0).toBeCloseTo(expectedT0!, 12);
      expect(residual).toBeCloseTo(expectedResidual!, 12);

      for (const call of callsOf(golden, "autotuner.chart.make_grid")) {
        const [b, t, first] = call.args as number[];
        const grid = call.result as { bpm: number; gap: number };
        expect(makeGrid(b!, t!, first!)).toEqual({ bpm: grid.bpm, gap: grid.gap });
      }
      const [tuning] = callsOf(golden, "autotuner.chart.tuning_offset");
      const track = tuning!.args[0] as Track;
      // NumPy computes this with the C library's float32 cosf/sinf/atan2f; JavaScript only has the float64 ones,
      // so the last float32 bit can differ (2e-10 semitones on one song).
      expect(tuningOffset(track.midi)).toBeCloseTo(tuning!.result as number, 9);
      const [scale] = callsOf(golden, "autotuner.chart.estimate_scale");
      expect(estimateScale(track.midi, scale!.args[1] as number)).toEqual(scale!.result);

      const assigned = callsOf(golden, "autotuner.boundary.assign");
      expect(assigned.length).toBeGreaterThan(0);
      for (const call of assigned) {
        const [starts, probs] = call.args as [number[], Float32Array];
        const { radius, min_prob, cost } = call.kwargs as { radius: number; min_prob: number; cost: number };
        expect(assign(starts, probs, radius, min_prob, cost)).toEqual(call.result);
      }
    });
  }
});
