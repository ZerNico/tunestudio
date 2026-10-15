import { createRoot, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import { createLoop, loopBack, loopStart } from "./loop";

/** A grid of 0.1 s steps; the song is 10 s long. */
function setup() {
  return createRoot(() => {
    const onSeek = vi.fn();
    const loop = createLoop({ snap: (seconds) => Math.round(seconds * 10) / 10, length: () => 10, onSeek });
    return { loop, onSeek };
  });
}

describe("loop", () => {
  it("starts at the range from outside it, and goes back at its end", () => {
    const range = { start: 2, end: 4 };
    expect([loopStart(1, range), loopStart(3, range), loopStart(4, range)]).toEqual([2, 3, 2]);
    expect([loopBack(3.9, range), loopBack(4, range)]).toEqual([null, 2]);
  });

  it("seeks on a click and marks a range on the grid with a drag, looping it", () => {
    const { loop, onSeek } = setup();
    loop.down(3, 100, null);
    loop.move(3.01, 101);
    loop.up();
    expect(onSeek).toHaveBeenCalledWith(3.01);
    expect(loop.range()).toBeNull();

    loop.down(5.04, 200, null);
    loop.move(2.02, 80);
    flush();
    // Drawn while dragging, not looping yet.
    expect(loop.range()).toEqual({ start: 2, end: 5 });
    expect(loop.on()).toBe(false);
    loop.up();
    flush();
    expect(loop.range()).toEqual({ start: 2, end: 5 });
    expect(loop.on()).toBe(true);
    expect([loop.startAt(1), loop.back(5)]).toEqual([2, 2]);
  });

  it("moves an edge, keeps the range when cancelled, and keeps inside the song", () => {
    const { loop } = setup();
    loop.down(2, 0, null);
    loop.move(4, 50);
    loop.up();
    loop.down(4, 50, "end");
    loop.move(12, 300);
    loop.up();
    flush();
    expect(loop.range()).toEqual({ start: 2, end: 10 });
    loop.down(2, 0, "start");
    loop.move(6, 100);
    loop.cancel();
    flush();
    expect(loop.range()).toEqual({ start: 2, end: 10 });
  });

  it("toggles with L, over the selection when there is one, and says when there is nothing", () => {
    const { loop } = setup();
    expect(loop.toggle(null)).toBe(false);
    expect(loop.toggle({ start: 1.02, end: 1.48 })).toBe(true);
    flush();
    expect([loop.on(), loop.range()]).toEqual([true, { start: 1, end: 1.5 }]);
    loop.toggle(null);
    flush();
    // Off: playing isn't held to the range, which stays for next time.
    expect([loop.on(), loop.startAt(5), loop.back(5)]).toEqual([false, 5, null]);
    expect(loop.toggle(null)).toBe(true);
    // A double-click outside the range leaves it.
    loop.clearAt(3);
    flush();
    expect(loop.range()).not.toBeNull();
    loop.clearAt(1.2);
    flush();
    expect([loop.on(), loop.range()]).toEqual([false, null]);
  });
});
