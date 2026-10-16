import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type { EditorSong } from "~/lib/native/types";

import type { LineSpan } from "./chart";
import { createSongMarkers, medleyOver, nearestLineEdge } from "./song-markers";
import { testSong } from "./test-chart";

const line = (start: number, duration: number): LineSpan => ({ id: start, singer: 1, start, duration, text: "" });
/** Lines at 10-14 s, 20-25 s and 30-33 s. */
const lines = [line(10, 4), line(20, 5), line(30, 3)];

function setup(song: Partial<EditorSong> = {}) {
  return createRoot(() => {
    const [current, setCurrent] = createSignal<EditorSong>({ ...testSong, ...song });
    const onChange = vi.fn((_label: string, patch: Partial<EditorSong>) =>
      setCurrent((previous) => ({ ...previous, ...patch })),
    );
    const onSeek = vi.fn();
    const markers = createSongMarkers({
      song: current,
      length: () => 60,
      snap: (seconds) => Math.round(seconds * 10) / 10,
      lines: () => lines,
      onChange,
      onSeek,
    });
    const drag = (marker: Parameters<typeof markers.down>[0], time: number) => {
      markers.down(marker);
      markers.move(time);
      flush();
      const shown = markers.at(marker);
      markers.up();
      flush();
      return shown;
    };
    return { markers, onChange, onSeek, drag, current };
  });
}

describe("song markers", () => {
  it("finds the nearest line start or end, and a medley over lines", () => {
    expect(nearestLineEdge(lines, 18, "start")).toBe(20);
    expect(nearestLineEdge(lines, 18, "end")).toBe(14);
    expect(nearestLineEdge([], 18, "end")).toBeNull();
    expect(medleyOver([lines[0]!, lines[1]!])).toEqual({ start: 10, end: 25 });
    expect(medleyOver([])).toBeNull();
  });

  it("drags start and end on the grid, shown while dragged and written once let go", () => {
    const { markers, onChange, drag } = setup();
    expect([markers.at("start"), markers.at("end")]).toEqual([null, null]);
    expect(drag("start", 5.04)).toBe(5);
    expect(onChange).toHaveBeenLastCalledWith("Move start", { start: 5 });
    expect(drag("end", 50.06)).toBe(50.1);
    expect(onChange).toHaveBeenLastCalledWith("Move end", { end: 50.1 });
  });

  it("keeps start before end, both in the song", () => {
    const { drag } = setup({ start: 5, end: 50 });
    expect(drag("start", 70)).toBe(49);
    expect(drag("end", -3)).toBe(50);
    expect(drag("preview", 99)).toBe(60);
  });

  it("snaps the medley to line starts and ends, in order", () => {
    const { drag, current } = setup({ medleyStart: 10, medleyEnd: 25 });
    expect(drag("medleyStart", 18)).toBe(20);
    expect(drag("medleyEnd", 12)).toBe(25);
    expect(drag("medleyEnd", 31)).toBe(33);
    expect(current()).toMatchObject({ medleyStart: 20, medleyEnd: 33 });
  });

  it("writes nothing for a marker let go where it was", () => {
    const { markers, onChange } = setup({ start: 5 });
    markers.down("start");
    markers.up();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("sets a marker at the playhead within its limits, the medley from lines, and clears them", () => {
    const { markers, onChange, current } = setup({ start: 5, end: 50 });
    markers.set("start", 55);
    expect(current().start).toBe(49);
    markers.setMedley([lines[1]!, lines[2]!]);
    expect(onChange).toHaveBeenLastCalledWith("Set medley", { medleyStart: 20, medleyEnd: 33 });
    markers.clear("medleyEnd");
    expect(onChange).toHaveBeenLastCalledWith("Clear medley", { medleyStart: null, medleyEnd: null });
    markers.clear("preview");
    expect(onChange).toHaveBeenLastCalledWith("Clear preview start", { previewStart: null });
  });

  it("forgets a start moved back to the song's start and an end moved to its end", () => {
    const { drag, markers, current } = setup({ start: 5, end: 50 });
    drag("start", -2);
    expect(current().start).toBeNull();
    markers.set("end", 70);
    expect(current().end).toBeNull();
    // Shown at the song's ends meanwhile.
    expect([markers.at("start"), markers.at("end")]).toEqual([null, null]);
  });

  it("takes a press on a marker that doesn't move for a click, which moves the playhead", () => {
    const { markers, onChange, onSeek } = setup({ start: 5 });
    markers.down("start", 5.02, 100);
    markers.move(5.04, 102);
    markers.up();
    expect(onChange).not.toHaveBeenCalled();
    expect(onSeek).toHaveBeenCalledWith(5.02);
    markers.down("start", 5, 100);
    markers.move(8, 140);
    markers.up();
    expect(onChange).toHaveBeenLastCalledWith("Move start", { start: 8 });
  });
});
