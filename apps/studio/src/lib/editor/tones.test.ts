import { describe, expect, it } from "vitest";

import { createTones, type ToneNote } from "./tones";
import { midiToHz } from "./voice-pitch";

/** An audio context as far as tones use it: oscillators record when they start and stop. */
class FakeContext {
  currentTime = 0;
  outputLatency = 0;
  baseLatency = 0;
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
    tones.frame(0.89, 1);
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

  it("starts tones early by the output's delay, which the song's time already allows for", () => {
    // Bluetooth headphones: heard 0.15 s after scheduled.
    const { context, tones } = setup([note(1, 1, 60), note(2, 1.2, 62)]);
    context.outputLatency = 0.14;
    context.baseLatency = 0.01;
    tones.frame(0.89, 1);
    tones.frame(0.9, 1);
    // Note 1 should start in 0.1 s, too soon: at once, its end still on time. Note 2 is in reach early.
    expect(context.oscillators.map(({ start, stop }) => [start, stop])).toEqual([
      [0, expect.closeTo(0.45, 9)],
      [expect.closeTo(0.15, 9), expect.closeTo(0.65, 9)],
    ]);
  });

  it("waits until the song is heard: its time stays put until then", () => {
    const { context, tones } = setup([note(1, 0.2, 60)]);
    context.outputLatency = 0.2;
    tones.frame(0, 1);
    context.currentTime = 0.1;
    tones.frame(0, 1);
    expect(context.oscillators).toHaveLength(0);
    // Heard from 0.2 s on: the note is due now, and starts early by the delay.
    context.currentTime = 0.2;
    tones.frame(0.01, 1);
    expect(context.oscillators[0]).toMatchObject({ start: 0.2, stop: expect.closeTo(0.69, 9) });
  });

  it("schedules nothing past a loop's end", () => {
    const { context, tones } = setup([{ ...note(1, 1, 60), duration: 1 }, note(2, 2.1, 62)]);
    context.outputLatency = 0.2;
    tones.frame(1.69, 1, 2);
    tones.frame(1.7, 1, 2);
    context.currentTime = 0.2;
    tones.frame(1.9, 1, 2);
    // Note 1 is cut at the end, note 2 (after it) never starts.
    expect(context.oscillators.map(({ start, stop }) => [start, stop])).toEqual([[0, expect.closeTo(0.1, 9)]]);
  });

  it("plays at half speed later and longer", () => {
    const { tones, context } = setup([note(1, 1, 60)]);
    tones.frame(0.94, 0.5);
    tones.frame(0.95, 0.5);
    expect(context.oscillators[0]).toMatchObject({ start: expect.closeTo(0.1, 9), stop: expect.closeTo(1.1, 9) });
  });

  it("starts again after a jump, with the rest of a note already sounding", () => {
    const { context, tones, started } = setup([note(1, 1, 60), note(2, 3, 67)]);
    tones.frame(0.89, 1);
    tones.frame(0.9, 1);
    context.currentTime = 0.05;
    // A seek to 1.4 s (0.95 s was expected), inside note 1: the song is heard from there a little later.
    tones.frame(1.4, 1);
    expect(context.oscillators[0]!.stopped).toBe(true);
    expect(context.oscillators).toHaveLength(1);
    context.currentTime = 0.06;
    tones.frame(1.41, 1);
    expect(started().at(-1)).toEqual([60, 0.06]);
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
    tones.frame(0.99, 1);
    tones.frame(1, 1);
    expect(context.oscillators).toHaveLength(3);

    shown = [first];
    context.currentTime = 0.05;
    tones.frame(1.05, 1);
    expect(context.oscillators.slice(0, 3).every((item) => item.stopped)).toBe(true);
    context.currentTime = 0.1;
    tones.frame(1.1, 1);
    expect(context.oscillators).toHaveLength(4);
    expect(context.oscillators[3]).toMatchObject({ frequency: midiToHz(60), start: 0.1, stop: expect.closeTo(3, 9) });

    shown = all;
    context.currentTime = 1;
    tones.frame(2, 1);
    expect(context.oscillators[3]!.stopped).toBe(true);
    context.currentTime = 1.01;
    tones.frame(2.01, 1);
    expect(context.oscillators).toHaveLength(6);
    expect(context.oscillators.slice(4)).toEqual([
      { frequency: midiToHz(60), start: 1.01, stop: expect.closeTo(3, 9), stopped: false },
      { frequency: midiToHz(67), start: 1.01, stop: expect.closeTo(3, 9), stopped: false },
    ]);
    tones.dispose();
  });

  it("previews a pitch at once", () => {
    const { tones, started } = setup([]);
    tones.preview(65);
    expect(started()).toEqual([[65, 0]]);
  });
});
