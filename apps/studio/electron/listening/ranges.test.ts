import { describe, expect, it } from "vitest";

import { voicedRanges } from "./ranges";

const RATE = 16_000;

/** Mono audio from parts: seconds of silence (null) or of a tone at `level` (0 to 1). */
function audio(parts: [seconds: number, level: number | null][]): Float32Array {
  const samples = new Float32Array(Math.round(parts.reduce((sum, [seconds]) => sum + seconds, 0) * RATE));
  let at = 0;
  for (const [seconds, level] of parts) {
    const count = Math.round(seconds * RATE);
    if (level !== null)
      for (let i = 0; i < count; i++) samples[at + i] = level * Math.sin((2 * Math.PI * 220 * i) / RATE);
    at += count;
  }
  return samples;
}

describe("voicedRanges", () => {
  it("finds the sung stretches with a little room around them, ignoring quiet bleed and clicks", () => {
    const ranges = voicedRanges(
      audio([
        [2, 0.001], // what the separation left of the instrument: far quieter than the voice
        [3, 0.5],
        [4, null],
        [0.1, 0.5], // a click
        [4, null],
        [2, 0.4],
        [1, null],
      ]),
      RATE,
    );
    expect(ranges).toEqual([
      { start: 1.8, end: 5.2 },
      { start: 12.9, end: 15.3 },
    ]);
  });

  it("hears nearby lines together and keeps breaths inside a line", () => {
    const ranges = voicedRanges(
      audio([
        [1, null],
        [2, 0.5],
        [0.3, null], // a breath
        [2, 0.5],
        [2, null], // between two lines
        [3, 0.5],
        [1, null],
      ]),
      RATE,
    );
    expect(ranges).toEqual([{ start: 0.8, end: 10.5 }]);
  });

  it("splits a long passage at its quietest moment, within Whisper's 30 s", () => {
    const ranges = voicedRanges(
      audio([
        [25, 0.5],
        [0.4, 0.05], // quieter, but still singing
        [20, 0.5],
      ]),
      RATE,
    );
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.start).toBe(0);
    expect(ranges[0]!.end).toBeGreaterThanOrEqual(25);
    expect(ranges[0]!.end).toBeLessThanOrEqual(25.4);
    expect(ranges[1]!.start).toBe(ranges[0]!.end);
    expect(ranges[1]!.end).toBeCloseTo(45.4, 1);
    for (const range of ranges) expect(range.end - range.start).toBeLessThanOrEqual(28);
  });

  it("finds nothing in silence", () => {
    expect(voicedRanges(audio([[5, null]]), RATE)).toEqual([]);
    expect(voicedRanges(new Float32Array(0), RATE)).toEqual([]);
  });
});
