import { describe, expect, it } from "vitest";

import { detectPitch, foldOctave, hzToMidi } from "./voice-pitch";

const RATE = 48_000;

/** 2048 samples of a tone at `hz` with a few overtones, as a voice has. */
function tone(hz: number, level = 0.3): Float32Array {
  return Float32Array.from({ length: 2048 }, (_, i) => {
    const t = i / RATE;
    return (
      level *
      (Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t) + 0.25 * Math.sin(6 * Math.PI * hz * t))
    );
  });
}

describe("the pitch sung into the microphone", () => {
  it("finds the pitch of sung notes, low and high", () => {
    for (const hz of [110, 196, 261.63, 440, 880]) expect(detectPitch(tone(hz), RATE)!).toBeCloseTo(hz, 0);
    expect(hzToMidi(detectPitch(tone(440), RATE)!)).toBeCloseTo(69, 1);
  });

  it("finds nothing in silence or noise", () => {
    expect(detectPitch(tone(440, 0.001), RATE)).toBeNull();
    let seed = 1;
    const noise = Float32Array.from({ length: 2048 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed / 2 ** 32 - 0.5) * 0.5;
    });
    expect(detectPitch(noise, RATE)).toBeNull();
  });

  it("moves a pitch an octave off onto the note, as games do", () => {
    expect(foldOctave(57.2, 69)).toBeCloseTo(69.2);
    expect(foldOctave(83, 69)).toBe(71);
  });
});
