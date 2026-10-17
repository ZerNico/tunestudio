import { describe, expect, it } from "vitest";

import type { Waveform } from "~/lib/native/types";

import { loudest, waveColumns } from "./waveform";

/** 10 ms values: quiet, then loud at 0.02 s, then quiet. */
const waveform: Waveform = { hop: 0.01, levels: [0.1, 0.1, 0.5, 0.2, 0, 0] };

describe("the waveform lane", () => {
  it("takes each column's loudest value, scaled to the loud parts and cut off above them", () => {
    // 100 px a second: one value per pixel.
    expect(waveColumns(waveform, { start: 0, pxPerSecond: 100 }, 4, 0.5)).toEqual([0.2, 0.2, 1, 0.4]);
    expect(waveColumns(waveform, { start: 0, pxPerSecond: 100 }, 4, 0.2)).toEqual([0.5, 0.5, 1, 1]);
    // 50 px a second: two values per pixel.
    expect(waveColumns(waveform, { start: 0, pxPerSecond: 50 }, 3, 0.5)).toEqual([0.2, 1, 0]);
    // Past the end, nothing.
    expect(waveColumns(waveform, { start: 1, pxPerSecond: 100 }, 2)).toEqual([0, 0]);
  });

  it("repeats a value across the columns it covers when zoomed in", () => {
    expect(waveColumns(waveform, { start: 0.02, pxPerSecond: 400 }, 4)).toEqual([1, 1, 1, 1]);
  });

  it("fills the lane with the loud parts, cutting off the loudest few, and keeps silence flat", () => {
    const levels = Array.from({ length: 100 }, (_, i) => (i < 98 ? 0.2 : 0.9));
    expect(loudest({ ...waveform, levels })).toBe(0.2);
    expect(loudest({ ...waveform, levels: [0, 0.001] })).toBe(0.05);
  });
});
