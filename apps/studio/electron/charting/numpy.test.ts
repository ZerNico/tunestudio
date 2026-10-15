import { describe, expect, it } from "vitest";

import reference from "./fixtures/numpy.json";
import {
  arange,
  argmax,
  complexMean,
  floorMod,
  mean,
  mean32,
  median,
  median32,
  pairwiseSum,
  percentile,
  percentile32,
  pyRound,
  std,
  std32,
} from "./numpy";

interface Case {
  x: number[];
  sum: number;
  mean: number;
  std: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  cmean: number[];
  zr: number[];
  zi: number[];
}

describe("numpy", () => {
  it("rounds halves to even and takes floor modulo like Python", () => {
    for (const [x, rounded] of reference.rounds) expect(pyRound(x!)).toBe(rounded);
    for (const [a, b, r] of reference.mods) expect(Object.is(floorMod(a!, b!), r) || floorMod(a!, b!) === r).toBe(true);
  });

  it("sums, averages and takes percentiles bit for bit like NumPy", () => {
    for (const [n, c] of Object.entries(reference.cases as Record<string, Case>)) {
      expect([n, pairwiseSum(c.x), mean(c.x), std(c.x), median(c.x)]).toEqual([n, c.sum, c.mean, c.std, c.median]);
      expect([10, 25, 75, 90].map((q) => percentile(c.x, q))).toEqual([c.p10, c.p25, c.p75, c.p90]);
      const interleaved = c.zr.flatMap((re, i) => [re, c.zi[i]!]);
      expect(complexMean(interleaved)).toEqual(c.cmean);
    }
  });

  it("keeps float32 statistics in float32 like NumPy", () => {
    for (const [n, c] of Object.entries(reference.cases32 as Record<string, Omit<Case, "cmean" | "zr" | "zi">>)) {
      const x = Float32Array.from(c.x);
      expect([n, pairwiseSum(x, 0, x.length, Math.fround), mean32(x), std32(x), median32(x)]).toEqual([
        n,
        c.sum,
        c.mean,
        c.std,
        c.median,
      ]);
      expect([10, 25, 75, 90].map((q) => percentile32(x, q))).toEqual([c.p10, c.p25, c.p75, c.p90]);
    }
  });

  it("steps through ranges like np.arange", () => {
    expect(Array.from(arange(80, 160, 0.05))).toEqual(reference.arange.a);
    expect(Array.from(arange(105.05 - 0.1, 105.05 + 0.1, 0.001))).toEqual(reference.arange.b);
  });

  it("takes the first largest value", () => {
    expect(argmax([1, 3, 3, 2])).toBe(1);
  });
});
