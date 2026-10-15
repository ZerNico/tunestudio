import { describe, expect, it } from "vitest";

import { createTones, midiToHz, type ToneNote } from "./tones";

/** An audio context as far as tones use it: oscillators record when they start and stop. */
class FakeContext {
  currentTime = 0;
  state = "running";
  destination = {};
  oscillators: { frequency: number; start: number; stop: number; stopped: boolean }[] = [];
  createGain() {
    const param = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} };
    return { gain: param, connect: (next: unknown) => next, disconnect() {} };
  }
  createOscillator() {
    const record = { frequency: 0, start: -1, stop: -1, stopped: false };
    this.oscillators.push(record);
    return {
      type: "",
      frequency: {
        set value(hz: number) {
          record.frequency = hz;
        },
      },
      connect: (next: unknown) => next,
      start: (at: number) => (record.start = at),
      stop: (at?: number) => {
        if (at === undefined) record.stopped = true;
        else record.stop = at;
      },
      addEventListener() {},
    };
  }
  resume() {}
  close() {}
}

const note = (id: number, start: number, pitch: number, type: ToneNote["type"] = "normal"): ToneNote => ({
  id,
  start,
  duration: 0.5,
  pitch,
  type,
});

function setup(notes: ToneNote[]) {
  const context = new FakeContext();
  const tones = createTones({ notes: () => notes, context: () => context as never });
  const started = () =>
    context.oscillators.map((item) => [Math.round(12 * Math.log2(item.frequency / 440)) + 69, item.start]);
  return { context, tones, started };
}

describe("tones", () => {
  it("gives a pitch its frequency", () => {
    expect(midiToHz(69)).toBe(440);
    expect(midiToHz(81)).toBeCloseTo(880, 9);
  });

  it("schedules the notes coming up as playback goes on, each once, at the speed it plays", () => {
    const { context, tones, started } = setup([note(1, 1, 60), note(2, 1.15, 62, "rap"), note(3, 1.3, 64)]);
    tones.frame(0.9, 1);
    // 0.2 s ahead: note 1 at 1 s, in 0.1 s.
    expect(started()).toEqual([[60, expect.closeTo(0.1, 9)]]);
    context.currentTime = 0.25;
    tones.frame(1.15, 1);
    // Note 3 in 0.15 s; the rap note is left out; note 1 isn't again.
    expect(started()).toEqual([
      [60, expect.closeTo(0.1, 9)],
      [64, expect.closeTo(0.4, 9)],
    ]);
  });

  it("plays at half speed later and longer", () => {
    const { tones, context } = setup([note(1, 1, 60)]);
    tones.frame(0.95, 0.5);
    expect(context.oscillators[0]).toMatchObject({ start: expect.closeTo(0.1, 9), stop: expect.closeTo(1.1, 9) });
  });

  it("starts again after a jump, with the rest of a note already sounding", () => {
    const { context, tones, started } = setup([note(1, 1, 60), note(2, 3, 67)]);
    tones.frame(0.9, 1);
    context.currentTime = 0.05;
    // A seek to 1.4 s (0.95 s was expected), inside note 1.
    tones.frame(1.4, 1);
    expect(context.oscillators[0]!.stopped).toBe(true);
    expect(started().at(-1)).toEqual([60, 0.05]);
    expect(context.oscillators.at(-1)!.stop).toBeCloseTo(0.15, 9);
  });

  it("previews a pitch at once", () => {
    const { tones, started } = setup([]);
    tones.preview(65);
    expect(started()).toEqual([[65, 0]]);
  });
});
