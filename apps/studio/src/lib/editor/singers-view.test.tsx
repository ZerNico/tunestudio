import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import type { EditorChart } from "~/lib/native/types";

import { createSingersView } from "./singers-view";
import { testSong } from "./test-chart";

const singer = (id: number, index: 1 | 2) => ({ id, index, name: null, lines: [] });
const chartOf = (...singers: ReturnType<typeof singer>[]): EditorChart => ({
  bpm: 300,
  gap: 0,
  song: testSong,
  singers,
});

function setup(initial: EditorChart) {
  return createRoot(() => {
    const [chart, setChart] = createSignal(initial);
    return { view: createSingersView(chart), setChart };
  });
}

describe("singers view", () => {
  it("chooses the active singer, falling back to the first that exists", () => {
    const { view, setChart } = setup(chartOf(singer(1, 1), singer(2, 2)));
    expect([view.index(), view.id()]).toEqual([1, 1]);
    view.choose(2);
    flush();
    expect([view.index(), view.id()]).toEqual([2, 2]);
    // P2 removed (or Add singer undone): back to P1.
    setChart(chartOf(singer(1, 1)));
    flush();
    expect([view.index(), view.id()]).toEqual([1, 1]);
  });

  it("hides a singer, moving the active one; never hides the last one shown; choosing shows it again", () => {
    const { view } = setup(chartOf(singer(1, 1), singer(2, 2)));
    view.setHidden(1, true);
    flush();
    expect(view.isHidden(1)).toBe(true);
    expect(view.index()).toBe(2);
    view.setHidden(2, true);
    flush();
    expect(view.isHidden(2)).toBe(false);
    view.choose(1);
    flush();
    expect([view.isHidden(1), view.index()]).toEqual([false, 1]);
    view.solo(2);
    flush();
    expect([view.isHidden(1), view.index()]).toEqual([true, 2]);
    view.showAll();
    flush();
    expect(view.isHidden(1)).toBe(false);
  });

  it("shows a singer brought back by undo or redo, though it was hidden before", () => {
    const { view, setChart } = setup(chartOf(singer(1, 1), singer(2, 2)));
    view.setHidden(2, true);
    flush();
    setChart(chartOf(singer(1, 1)));
    flush();
    setChart(chartOf(singer(1, 1), singer(2, 2)));
    flush();
    expect(view.isHidden(2)).toBe(false);
  });

  it("hides nothing in a solo chart", () => {
    const { view, setChart } = setup(chartOf(singer(1, 1), singer(2, 2)));
    view.setHidden(2, true);
    setChart(chartOf(singer(2, 2)));
    flush();
    expect(view.isHidden(2)).toBe(false);
    expect(view.index()).toBe(2);
  });
});
