import { describe, expect, it } from "vitest";

import {
  clampView,
  fitRange,
  follow,
  onPage,
  revealSpan,
  formatTime,
  gridLevel,
  gridLines,
  pitchName,
  pitchRange,
  pitchToY,
  rulerStep,
  rulerTicks,
  scrollBy,
  timeToX,
  visibleItems,
  xToTime,
  zoomAt,
} from "./view";

const view = { start: 10, pxPerSecond: 100 };

describe("time view", () => {
  it("maps time and pixels both ways", () => {
    expect(timeToX(view, 12.5)).toBe(250);
    expect(xToTime(view, 250)).toBe(12.5);
  });

  it("zooms keeping the time under the pointer in place", () => {
    const zoomed = zoomAt(view, 2, 300, 800, 200);
    expect(zoomed.pxPerSecond).toBe(200);
    expect(xToTime(zoomed, 300)).toBeCloseTo(13);
  });

  it("zooms out no further than the whole song", () => {
    // 800 px for a 200 s song: 4 px/s at the most zoomed out, starting at 0.
    const out = zoomAt(view, 0.001, 400, 800, 200);
    expect(out).toEqual({ start: 0, pxPerSecond: 4 });
    expect(zoomAt(view, 0.001, 400, 1000, 100)).toEqual({ start: 0, pxPerSecond: 10 });
  });

  it("never scrolls before the start or past the end of the song", () => {
    expect(scrollBy(view, -5000, 800, 60).start).toBe(0);
    // 800 px at 100 px/s is 8 s: the latest start for a 60 s song is 52 s.
    expect(scrollBy(view, 50_000, 800, 60).start).toBe(52);
    // A song shorter than the screen starts at 0.
    expect(clampView({ start: 3, pxPerSecond: 100 }, 800, 5).start).toBe(0);
  });

  it("fits a stretch with some room around it", () => {
    const fitted = fitRange(20, 30, 1000, 200);
    expect(xToTime(fitted, 0)).toBeLessThan(20);
    expect(xToTime(fitted, 1000)).toBeGreaterThan(30);
  });

  it("follows the playhead a page at a time", () => {
    expect(follow(view, 12, 800, 200)).toBe(view);
    // On the page: up to just short of the right edge.
    expect([onPage(view, 12, 800), onPage(view, 17.9, 800), onPage(view, 9, 800)]).toEqual([true, false, false]);
    const paged = follow(view, 17.9, 800, 200);
    expect(paged.start).toBeGreaterThan(17);
    expect(paged.start).toBeLessThan(17.9);
  });
});

describe("ruler", () => {
  it("picks the finest step whose labels don't crowd", () => {
    expect(rulerStep(1000)).toBe(0.1);
    expect(rulerStep(100)).toBe(1);
    expect(rulerStep(5)).toBe(15);
  });

  it("marks whole steps on screen without float drift", () => {
    expect(rulerTicks({ start: 0.05, pxPerSecond: 1000 }, 400)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("draws every grid step when they are far enough apart, else every 4th, 16th …", () => {
    // 0.05 s steps from 1 s: 10 px apart at 200 px/s.
    const grid = { start: 1, step: 0.05 };
    expect(gridLines(grid, { start: 1.02, pxPerSecond: 200 }, 40)).toEqual([1, 2, 3, 4]);
    // 1.5 px apart: every 4th (6 px) is still too close, every 16th (24 px) isn't.
    expect(gridLines(grid, { start: 0, pxPerSecond: 30 }, 100)).toEqual([-16, 0, 16, 32]);
    expect([0, 1, 4, 16, -16].map(gridLevel)).toEqual([2, 0, 1, 2, 2]);
    expect(gridLines({ start: 0, step: 0 }, view, 100)).toEqual([]);
  });

  it("formats times as minutes and seconds", () => {
    expect(formatTime(67.46)).toBe("1:07.4");
    expect(formatTime(5, false)).toBe("0:05");
  });
});

describe("pitch rows", () => {
  it("spans the chart's notes with a row of room, at least an octave and a half", () => {
    expect(pitchRange([50, 80])).toEqual({ low: 49, high: 81 });
    // An octave: made up to 18 rows.
    expect(pitchRange([60, 72])).toEqual({ low: 58, high: 75 });
    const narrow = pitchRange([64]);
    expect(narrow.high - narrow.low + 1).toBe(18);
    expect(narrow.low).toBeLessThan(64);
    expect(narrow.high).toBeGreaterThan(64);
  });

  it("puts the highest pitch on top and names pitches", () => {
    expect(pitchToY({ low: 60, high: 72 }, 10, 72)).toBe(0);
    expect(pitchToY({ low: 60, high: 72 }, 10, 60)).toBe(120);
    expect(pitchName(64)).toBe("E4");
    expect(pitchName(61)).toBe("C♯4");
  });
});

describe("visibleItems", () => {
  const notes = [
    { start: 0, duration: 1 },
    { start: 2, duration: 4 },
    { start: 5, duration: 0.5 },
    { start: 9, duration: 1 },
  ];

  it("finds the notes overlapping the window, including long ones that started before it", () => {
    expect(visibleItems(notes, 4, 8, 4)).toEqual([notes[1], notes[2]]);
    expect(visibleItems(notes, 10.5, 12, 4)).toEqual([]);
    expect(visibleItems([], 0, 10, 0)).toEqual([]);
  });
});

describe("revealSpan", () => {
  it("leaves a span on screen as it is, and scrolls one off screen in with the lead given", () => {
    const view = { start: 10, pxPerSecond: 100 };
    // 8 s on screen.
    expect(revealSpan(view, { start: 11, end: 12 }, 800, 200, 0.25)).toBe(view);
    expect(revealSpan(view, { start: 30, end: 31 }, 800, 200, 0.25)).toEqual({ start: 28, pxPerSecond: 100 });
  });
});
