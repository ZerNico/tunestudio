import { afterEach, describe, expect, it, vi } from "vitest";

import { createScrub } from "./scrub";

/** An audio context as far as scrubbing uses it: buffer sources record where they start and when they stop. */
class FakeContext {
  currentTime = 0;
  state = "running";
  destination = {};
  grains: { offset: number; length: number; stop: number | null }[] = [];
  createGain() {
    const param = {
      value: 1,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      cancelScheduledValues() {},
    };
    return { gain: param, connect: (next: unknown) => next };
  }
  createBufferSource() {
    const record = { offset: -1, length: -1, stop: null as number | null };
    this.grains.push(record);
    return {
      buffer: null,
      connect: (next: unknown) => next,
      start: (_at: number, offset: number, length: number) => {
        record.offset = offset;
        record.length = length;
      },
      stop: (at: number) => (record.stop = at),
      addEventListener() {},
    };
  }
  resume() {}
  close() {}
}

function setup() {
  const context = new FakeContext();
  let time = 1000;
  let url = "media://s/1";
  const loads: string[] = [];
  let finish: (ok?: boolean) => void = () => {};
  const scrub = createScrub({
    url: () => url,
    context: () => context as never,
    load: (from) => {
      loads.push(from);
      return new Promise((resolve, reject) => {
        finish = (ok = true) => (ok ? resolve({ duration: 10 } as AudioBuffer) : reject(new Error("unreadable")));
      });
    },
    now: () => time,
  });
  return {
    context,
    scrub,
    loads,
    decoded: async (ok = true) => {
      finish(ok);
      await new Promise((resolve) => setTimeout(resolve));
    },
    later: (ms: number) => {
      time += ms;
      vi.advanceTimersByTime(ms);
    },
    setUrl: (next: string) => (url = next),
    offsets: () => context.grains.map((grain) => grain.offset),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scrub", () => {
  it("decodes the source on the first move, and plays a short grain where the playhead is once it is in", async () => {
    const { scrub, loads, decoded, later, offsets, context } = setup();
    // Not decoded yet: quiet.
    scrub.at(2);
    expect(loads).toEqual(["media://s/1"]);
    expect(offsets()).toEqual([]);
    await decoded();
    vi.useFakeTimers();
    later(100);
    scrub.at(2.5);
    expect(offsets()).toEqual([2.5]);
    expect(context.grains[0]!.length).toBeCloseTo(0.09);
    // Past the end: nothing.
    later(100);
    scrub.at(12);
    expect(offsets()).toEqual([2.5]);
    expect(loads).toHaveLength(1);
  });

  it("keeps a pace: a move soon after a grain plays the latest time a moment later, fading out the one before", async () => {
    const { scrub, decoded, later, offsets, context } = setup();
    scrub.at(0);
    await decoded();
    vi.useFakeTimers();
    later(100);
    scrub.at(1);
    later(10);
    scrub.at(1.1);
    scrub.at(1.2);
    expect(offsets()).toEqual([1]);
    later(35);
    expect(offsets()).toEqual([1, 1.2]);
    expect(context.grains[0]!.stop).not.toBeNull();
  });

  it("goes quiet when the drag ends, dropping a grain held back", async () => {
    const { scrub, decoded, later, offsets, context } = setup();
    scrub.at(0);
    await decoded();
    vi.useFakeTimers();
    later(100);
    scrub.at(1);
    scrub.at(1.5);
    scrub.end();
    later(100);
    expect(offsets()).toEqual([1]);
    expect(context.grains[0]!.stop).not.toBeNull();
  });

  it("repeats a longer stretch where the playhead is held, until it moves or the drag ends", async () => {
    const { scrub, decoded, later, offsets, context } = setup();
    scrub.at(0);
    await decoded();
    vi.useFakeTimers();
    later(100);
    scrub.at(3);
    later(100);
    expect(offsets()).toEqual([3]);
    later(20);
    expect(offsets()).toEqual([3, 3]);
    expect(context.grains[1]!.length).toBeCloseTo(0.04);
    later(60);
    expect(offsets()).toEqual([3, 3, 3]);
    // A move plays a grain there and stops repeating the old spot.
    later(50);
    scrub.at(4);
    expect(offsets()).toEqual([3, 3, 3, 4]);
    expect(context.grains[2]!.stop).not.toBeNull();
    later(100);
    expect(offsets()).toEqual([3, 3, 3, 4]);
    scrub.end();
    later(1000);
    expect(offsets()).toEqual([3, 3, 3, 4]);
  });

  it("decodes another source when it is scrubbed", async () => {
    const { scrub, loads, decoded, setUrl } = setup();
    scrub.at(1);
    await decoded();
    scrub.at(1);
    setUrl("media://s/2");
    scrub.at(1);
    expect(loads).toEqual(["media://s/1", "media://s/2"]);
  });

  it("tries a file that couldn't be decoded again on the next drag", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { scrub, loads, decoded } = setup();
    scrub.at(1);
    await decoded(false);
    expect(warn).toHaveBeenCalled();
    scrub.at(1);
    expect(loads).toEqual(["media://s/1", "media://s/1"]);
  });
});
