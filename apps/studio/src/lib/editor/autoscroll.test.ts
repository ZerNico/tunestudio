import { describe, expect, it, vi } from "vitest";

import { createAutoScroll, EDGE_PX, scrollSpeed } from "./autoscroll";

const bounds = { left: 100, right: 900 };

describe("auto-scroll", () => {
  it("scrolls near an edge, faster the further in, and not in between", () => {
    expect(scrollSpeed(bounds, 500)).toBe(0);
    expect(scrollSpeed(bounds, 100 + EDGE_PX)).toBe(0);
    expect(scrollSpeed(bounds, 100 + EDGE_PX / 2)).toBe(-12);
    expect(scrollSpeed(bounds, 900 - EDGE_PX / 2)).toBe(12);
    // At the edge and past it: the fastest.
    expect(scrollSpeed(bounds, 950)).toBe(24);
    expect(scrollSpeed(bounds, 0)).toBe(-24);
  });

  it("scrolls a frame at a time while the drag stays at the edge, redoing it each time, until it ends", () => {
    const frames: (() => void)[] = [];
    const scroll = vi.fn();
    const auto = createAutoScroll({
      bounds: () => bounds,
      scroll,
      frame: (callback) => frames.push(callback),
      cancelFrame: () => frames.splice(0),
    });
    const redo = vi.fn(() => auto.track(950, redo));
    auto.track(500, redo);
    expect(frames).toHaveLength(0);
    auto.track(950, redo);
    // Reported again: still the one loop.
    auto.track(950, redo);
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(scroll).toHaveBeenCalledWith(24);
    expect(redo).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
    auto.end();
    expect(frames).toHaveLength(0);
  });

  it("stops scrolling when the pointer leaves the edge", () => {
    const frames: (() => void)[] = [];
    const scroll = vi.fn();
    const auto = createAutoScroll({ bounds: () => bounds, scroll, frame: (callback) => frames.push(callback) });
    auto.track(950, () => {});
    auto.track(500, () => {});
    frames.shift()!();
    expect(scroll).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
  });
});
