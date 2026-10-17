import { flush } from "solid-js";
import { describe, expect, it } from "vitest";

import { createSingAlong, type Microphone } from "./sing-along";

const RATE = 48_000;

/** A microphone singing `hz` (null: silence), changed by the test. */
function fakeMicrophone() {
  const state = { hz: null as number | null, closed: false };
  const microphone: Microphone = {
    sampleRate: RATE,
    read: (into) => {
      for (let i = 0; i < into.length; i++)
        into[i] = state.hz === null ? 0 : 0.3 * Math.sin((2 * Math.PI * state.hz * i) / RATE);
    },
    close: () => void (state.closed = true),
  };
  return { state, microphone };
}

const NOTES = [{ start: 1, duration: 1, pitch: 69, type: "normal" as const }];

describe("singing along", () => {
  it("draws what is sung, folded onto the note's octave", async () => {
    const { state, microphone } = fakeMicrophone();
    const sing = createSingAlong({ notes: () => NOTES, length: () => 10, open: async () => microphone });
    await sing.start();
    flush();
    expect(sing.on()).toBe(true);
    // An octave below the note: drawn on it.
    state.hz = 220;
    sing.frame(1.5);
    flush();
    const index = Math.round((1.5 - 0.05) / 0.02);
    expect(sing.voice()!.midi[index]).toBeCloseTo(69, 0);
    // Off the notes it is drawn as sung (A3); silence draws nothing.
    sing.frame(5);
    state.hz = null;
    sing.frame(6);
    flush();
    expect(sing.voice()!.midi[Math.round(4.95 / 0.02)]).toBeCloseTo(57, 0);
    expect(sing.voice()!.midi[Math.round(5.95 / 0.02)]).toBeNull();
    // Sung again there (played again): it replaces what was drawn.
    state.hz = 493.88;
    sing.frame(1.5);
    flush();
    expect(sing.voice()!.midi[index]).toBeCloseTo(71, 0);
    // At half speed the voice comes later in song time: half the delay.
    sing.frame(3, 0.5);
    flush();
    expect(sing.voice()!.midi[Math.round((3 - 0.025) / 0.02)]).toBeCloseTo(71, 0);
    sing.stop();
    flush();
    expect(state.closed).toBe(true);
    expect(sing.voice()).toBeNull();
    expect(sing.on()).toBe(false);
  });

  it("closes a microphone that opens after it was stopped", async () => {
    const { state, microphone } = fakeMicrophone();
    let opened!: (value: Microphone) => void;
    const sing = createSingAlong({
      notes: () => NOTES,
      length: () => 10,
      open: () => new Promise((resolve) => (opened = resolve)),
    });
    const starting = sing.start();
    sing.stop();
    opened(microphone);
    await starting;
    flush();
    expect(state.closed).toBe(true);
    expect(sing.on()).toBe(false);
  });
});
