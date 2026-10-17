import { describe, expect, it } from "vitest";

import { levelsOf } from "./waveform";

describe("the waveform", () => {
  it("is the average loudness (RMS) of every 10 ms", () => {
    // 1000 samples a second: 10 per value.
    const samples = new Float32Array(25);
    samples.fill(0.5, 0, 10);
    samples.fill(-0.2, 10, 20);
    samples[20] = 1;
    expect(Array.from(levelsOf(samples, 1000), (value) => Math.round(value * 100) / 100)).toEqual([0.5, 0.2, 0.45]);
  });
});
