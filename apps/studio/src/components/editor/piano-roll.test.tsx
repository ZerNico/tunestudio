import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import type { DrawnNote, LineSpan } from "~/lib/editor/chart";

import { LyricsLane } from "./lanes";
import { PianoRoll } from "./piano-roll";

const note = (id: number, start: number, lyric: string, extra: Partial<DrawnNote> = {}): DrawnNote => ({
  id,
  start,
  duration: 0.5,
  pitch: 64,
  lyric,
  type: "normal",
  edited: false,
  singer: 1,
  lineId: 1,
  ...extra,
});

const view = { start: 10, pxPerSecond: 100 };
const range = { low: 55, high: 72 };

describe("PianoRoll", () => {
  it("places each note by time and pitch, coloured by singer and type", () => {
    render(() => (
      <PianoRoll
        notes={[note(1, 11, "Som"), note(2, 12, "mer", { singer: 2, pitch: 67, type: "golden" })]}
        breaks={[{ lineId: 1, singer: 1, time: 11.8, auto: true, gapStart: 11.5, gapEnd: 12 }]}
        range={range}
        view={view}
        width={800}
        height={180}
        onSeek={() => {}}
      />
    ));
    const [first, second] = screen.getAllByTestId("roll-note");
    expect(first).toHaveTextContent("Som");
    // 1 s after the view's start at 100 px/s; 18 rows in 180 px, E4 (64) is 8 rows below C5 (72).
    expect(first!.style.left).toBe("100px");
    expect(first!.style.top).toBe("81px");
    expect(second).toHaveAttribute("data-singer", "2");
    expect(second).toHaveAttribute("data-type", "golden");
    expect(second!.title).toBe("mer · G4");
    // The break at its switch time, fainter: default timing.
    const marker = screen.getByTestId("line-break");
    expect(Number.parseFloat(marker.style.left)).toBeCloseTo(180);
    expect(marker).toHaveAttribute("data-auto");
  });

  it("moves the playhead where the background is pressed", () => {
    const onSeek = vi.fn();
    render(() => (
      <PianoRoll notes={[]} breaks={[]} range={range} view={view} width={800} height={180} onSeek={onSeek} />
    ));
    const area = screen.getByTestId("roll-area");
    area.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 180,
      width: 800,
      height: 180,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(area, { button: 0, clientX: 250 });
    expect(onSeek).toHaveBeenCalledWith(12.5);
  });
});

describe("LyricsLane", () => {
  it("shows each line's text, cut where the singer's next line starts", () => {
    const lines: LineSpan[] = [
      { id: 1, singer: 1, start: 11, duration: 1, text: "We walk on" },
      { id: 2, singer: 1, start: 13, duration: 1, text: "to the sea" },
    ];
    render(() => <LyricsLane lines={lines} all={lines} view={view} duet={false} />);
    const shown = screen.getAllByTestId("lyrics-line");
    expect(shown.map((line) => line.textContent)).toEqual(["We walk on", "to the sea"]);
    expect(shown[0]!.style.maxWidth).toBe("194px");
  });
});
