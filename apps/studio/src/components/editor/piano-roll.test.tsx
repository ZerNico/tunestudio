import { fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
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

/** What every roll needs; tests override what they look at. */
const handlers = () => ({
  selected: new Set<number>(),
  overlapping: new Set<number>(),
  onNoteDown: vi.fn(),
  onEmptyClick: vi.fn(),
  onBox: vi.fn(),
});

/** The drawing area at the page's corner, 800 × 180 px, with pointer capture (jsdom has none). */
function rollArea() {
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
  area.setPointerCapture = () => {};
  return area;
}

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
        {...handlers()}
        selected={new Set([2])}
        overlapping={new Set([1])}
      />
    ));
    const [first, second] = screen.getAllByTestId("roll-note");
    expect(first).toHaveTextContent("Som");
    // 1 s after the view's start at 100 px/s; 18 rows in 180 px, E4 (64) is 8 rows below C5 (72).
    expect(first!.style.left).toBe("100px");
    expect(first!.style.top).toBe("81px");
    expect(second).toHaveAttribute("data-singer", "2");
    expect(second).toHaveAttribute("data-type", "golden");
    expect(second!.title).toBe("mer · G4 · golden");
    expect(second).toHaveAttribute("data-selected");
    expect(first).not.toHaveAttribute("data-selected");
    expect(first).toHaveAttribute("data-overlap");
    // A problem shows in the label and the tooltip.
    expect(first).toHaveTextContent("⚠ Som");
    expect(first!.title).toBe("Som · E4 · ⚠ overlaps another note");
    // The break at its switch time, fainter: default timing.
    const marker = screen.getByTestId("line-break");
    expect(Number.parseFloat(marker.style.left)).toBeCloseTo(180);
    expect(marker).toHaveAttribute("data-auto");
  });

  it("reports a click on empty space with its time", () => {
    const props = handlers();
    render(() => <PianoRoll notes={[]} breaks={[]} range={range} view={view} width={800} height={180} {...props} />);
    const area = rollArea();
    fireEvent.pointerDown(area, { button: 0, clientX: 250, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(area, { clientX: 251, clientY: 50, pointerId: 1 });
    expect(props.onEmptyClick).toHaveBeenCalledWith(12.5);
    expect(props.onBox).not.toHaveBeenCalled();
  });

  it("draws a selection box on a drag and reports the times and pitches it covers", () => {
    const props = handlers();
    render(() => <PianoRoll notes={[]} breaks={[]} range={range} view={view} width={800} height={180} {...props} />);
    const area = rollArea();
    fireEvent.pointerDown(area, { button: 0, clientX: 100, clientY: 15, pointerId: 1 });
    fireEvent.pointerMove(area, { clientX: 300, clientY: 85, pointerId: 1 });
    flush();
    expect(screen.getByTestId("selection-box").style.width).toBe("200px");
    fireEvent.pointerUp(area, { clientX: 300, clientY: 85, shiftKey: true, pointerId: 1 });
    // 10 px rows from 72 down: 15 px is in row 1 (71), 85 px in row 8 (64).
    expect(props.onBox).toHaveBeenCalledWith({ from: 11, to: 13, low: 64, high: 71 }, true);
    expect(props.onEmptyClick).not.toHaveBeenCalled();
    flush();
    expect(screen.queryByTestId("selection-box")).toBeNull();
  });

  it("reports a press on a note's body or edges, with the roll's scale", () => {
    const props = handlers();
    render(() => (
      <PianoRoll
        notes={[note(1, 11, "Som"), note(2, 12, "x", { duration: 0.05 })]}
        breaks={[]}
        range={range}
        view={view}
        width={800}
        height={180}
        {...props}
      />
    ));
    const [wide, narrow] = screen.getAllByTestId("roll-note");
    const scale = { pxPerSecond: 100, rowHeight: 10 };
    fireEvent.pointerDown(wide!, { button: 0, shiftKey: true });
    expect(props.onNoteDown).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ shiftKey: true }),
      "body",
      scale,
    );
    fireEvent.pointerDown(screen.getAllByTestId("note-end-edge")[0]!, { button: 0 });
    expect(props.onNoteDown).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 1 }),
      expect.anything(),
      "end",
      scale,
    );
    expect(props.onNoteDown).toHaveBeenCalledTimes(2);
    // 5 px wide: no edges, so a press anywhere moves it.
    expect(narrow!.querySelector("[data-testid=note-start-edge]")).toBeNull();
  });

  it("draws dragged notes where the drag has them, with its label", () => {
    render(() => (
      <PianoRoll
        notes={[note(1, 11, "Som")]}
        breaks={[]}
        range={range}
        view={view}
        width={800}
        height={180}
        {...handlers()}
        drag={{ ids: new Set([1]), part: "body", time: 0.5, pitch: 2, anchor: 1, label: "+2 steps · F♯4" }}
      />
    ));
    const moved = screen.getByTestId("roll-note");
    expect(moved.style.left).toBe("150px");
    expect(moved.style.top).toBe("61px");
    expect(screen.getByTestId("drag-label")).toHaveTextContent("+2 steps · F♯4");
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
