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
  createBiquadFilter() {
    return { type: "", frequency: { value: 0 }, connect: (next: unknown) => next };
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

  it("stops hidden notes, including scheduled ones, and plays the rest when shown again", () => {
    const context = new FakeContext();
    const first = { ...note(1, 0, 60), duration: 4 };
    const second = { ...note(2, 0, 67), duration: 4 };
    const upcoming = note(3, 1.1, 69);
    const all = [first, second, upcoming];
    let shown = all;
    const tones = createTones({ notes: () => shown, context: () => context as never });
    tones.frame(1, 1);
    expect(context.oscillators).toHaveLength(3);

    shown = [first];
    context.currentTime = 0.05;
    tones.frame(1.05, 1);
    expect(context.oscillators.slice(0, 3).every((item) => item.stopped)).toBe(true);
    expect(context.oscillators).toHaveLength(4);
    expect(context.oscillators[3]).toMatchObject({ frequency: midiToHz(60), start: 0.05, stop: 3 });

    context.currentTime = 0.1;
    tones.frame(1.1, 1);
    expect(context.oscillators).toHaveLength(4);

    shown = all;
    context.currentTime = 1;
    tones.frame(2, 1);
    expect(context.oscillators[3]!.stopped).toBe(true);
    expect(context.oscillators).toHaveLength(6);
    expect(context.oscillators.slice(4)).toEqual([
      { frequency: midiToHz(60), start: 1, stop: 3, stopped: false },
      { frequency: midiToHz(67), start: 1, stop: 3, stopped: false },
    ]);
    tones.dispose();
  });

  it("previews a pitch at once", () => {
    const { tones, started } = setup([]);
    tones.preview(65);
    expect(started()).toEqual([[65, 0]]);
  });
});
