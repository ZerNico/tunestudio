import { fireEvent, render, screen } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type { DrawnNote, LineSpan } from "~/lib/editor/chart";
import type { Tool } from "~/lib/editor/tools";

import { BreakLane, LyricsLane } from "./lanes";
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
  tool: "select" as Tool,
  onDrawDown: vi.fn(),
  onEmptyDoubleClick: vi.fn(),
  onHover: vi.fn(),
  onSplit: vi.fn(),
  onNoteDoubleClick: vi.fn(),
  onLyricDone: vi.fn(),
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
  it("names every row when the rows are tall enough, else only the C's", () => {
    const shown = () =>
      screen
        .getAllByTestId("pitch-label")
        .filter((label) => !label.hidden)
        .map((label) => label.textContent);
    // 18 rows (G3 to C5) in 180 px: 10 px each.
    const { unmount } = render(() => (
      <PianoRoll notes={[]} breaks={[]} range={range} view={view} width={800} height={180} {...handlers()} />
    ));
    expect(shown()).toEqual(["C5", "C4"]);
    unmount();
    // In 360 px: 20 px each, every name; the black keys' dimmer.
    render(() => (
      <PianoRoll notes={[]} breaks={[]} range={range} view={view} width={800} height={360} {...handlers()} />
    ));
    expect(shown()).toHaveLength(18);
    const sharp = screen.getAllByTestId("pitch-label").find((label) => label.textContent === "C♯4")!;
    expect(sharp).toHaveAttribute("data-sharp");
  });

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
        pending={new Set([2])}
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
    // Auto pitch is working on the second one.
    expect(second).toHaveAttribute("data-pending");
    expect(first).not.toHaveAttribute("data-pending");
    // A problem shows in the label and the tooltip.
    expect(first).toHaveTextContent("⚠ Som");
    expect(first!.title).toBe("Som · E4 · ⚠ overlaps another note");
    // The break at its switch time, fainter: default timing.
    const marker = screen.getByTestId("line-break");
    // Just before its time (179 px is 1.8 s in), so it sits outside a note starting or ending there.
    expect(Number.parseFloat(marker.style.left)).toBeCloseTo(179);
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

  it("drops the selection box on Esc, before anything else hears it", () => {
    const props = handlers();
    render(() => <PianoRoll notes={[]} breaks={[]} range={range} view={view} width={800} height={180} {...props} />);
    const area = rollArea();
    const later = vi.fn();
    window.addEventListener("keydown", later);
    fireEvent.pointerDown(area, { button: 0, clientX: 100, clientY: 15, pointerId: 1 });
    fireEvent.pointerMove(area, { clientX: 300, clientY: 85, pointerId: 1 });
    fireEvent.keyDown(window, { key: "Escape" });
    flush();
    expect(screen.queryByTestId("selection-box")).toBeNull();
    expect(later).not.toHaveBeenCalled();
    fireEvent.pointerUp(area, { clientX: 300, clientY: 85, pointerId: 1 });
    expect(props.onBox).not.toHaveBeenCalled();
    expect(props.onEmptyClick).not.toHaveBeenCalled();
    window.removeEventListener("keydown", later);
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
    const scale = expect.objectContaining({ pxPerSecond: 100, rowHeight: 10 });
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

describe("PianoRoll tools", () => {
  const roll = (extra: Partial<ReturnType<typeof handlers>> & Record<string, unknown> = {}) => {
    const props = { ...handlers(), ...extra };
    render(() => (
      <PianoRoll
        notes={[note(1, 11, "Som")]}
        breaks={[]}
        range={range}
        view={view}
        width={800}
        height={180}
        {...props}
      />
    ));
    return { props, area: rollArea() };
  };

  it("draws with a press on empty space in the Draw tool, with the time and pitch there", () => {
    const { props, area } = roll({ tool: "draw" });
    fireEvent.pointerDown(area, { button: 0, clientX: 250, clientY: 85, pointerId: 1 });
    expect(props.onDrawDown).toHaveBeenCalledWith(
      { time: 12.5, pitch: 64 },
      expect.anything(),
      expect.objectContaining({ pxPerSecond: 100, rowHeight: 10 }),
    );
    expect(props.onEmptyClick).not.toHaveBeenCalled();
  });

  it("splits where a note is clicked in the Split tool, and shows the cut", () => {
    const { props } = roll({ tool: "split", cut: { noteId: 1, time: 11.2, valid: false } });
    const target = screen.getByTestId("roll-note");
    fireEvent.pointerMove(target, { clientX: 120, clientY: 85 });
    expect(props.onHover).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 11.2);
    fireEvent.pointerDown(target, { button: 0, clientX: 120, clientY: 85, shiftKey: true });
    expect(props.onSplit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 11.2, true);
    expect(props.onNoteDown).not.toHaveBeenCalled();
    const cut = screen.getByTestId("split-cut");
    expect(Number.parseFloat(cut.style.left)).toBeCloseTo(120);
    expect(cut).toHaveAttribute("data-invalid");
    // No resize edges while splitting.
    expect(screen.queryByTestId("note-end-edge")).toBeNull();
  });

  it("adds a note on a double-click on empty space, and types a syllable on one on a note", () => {
    const { props, area } = roll();
    fireEvent.dblClick(area, { clientX: 250, clientY: 85 });
    expect(props.onEmptyDoubleClick).toHaveBeenCalledWith({ time: 12.5, pitch: 64 });
    fireEvent.dblClick(screen.getByTestId("roll-note"));
    expect(props.onNoteDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("types a syllable in place: Enter keeps it, Tab goes on, Esc drops it", () => {
    const { props } = roll({ editingLyric: 1 });
    const input = screen.getByTestId("lyric-input") as HTMLInputElement;
    expect(input.value).toBe("Som");
    input.value = "Sonn";
    fireEvent.keyDown(input, { key: "Tab" });
    expect(props.onLyricDone).toHaveBeenLastCalledWith("Sonn", 1);
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(props.onLyricDone).toHaveBeenLastCalledWith("Sonn", -1);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onLyricDone).toHaveBeenLastCalledWith(null);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onLyricDone).toHaveBeenLastCalledWith("Sonn");
  });
});

describe("BreakLane", () => {
  it("presses, selects and double-clicks markers, adds where the lane is double-clicked, and labels a drag", () => {
    const props = { onDown: vi.fn(), onDoubleClick: vi.fn(), onLaneDoubleClick: vi.fn() };
    const breaks = [{ lineId: 7, singer: 1, time: 11.5, auto: true, gapStart: 11.5, gapEnd: 12 }];
    render(() => (
      <BreakLane
        breaks={breaks}
        view={view}
        selected={7}
        drag={{ lineId: 7, time: 11.5, label: "0:11.5 · 2 notes move" }}
        {...props}
      />
    ));
    const marker = screen.getByTestId("break-marker");
    expect(marker).toHaveAttribute("data-selected", "true");
    fireEvent.pointerDown(marker, { button: 0 });
    expect(props.onDown).toHaveBeenCalledWith(breaks[0], expect.anything());
    fireEvent.dblClick(marker);
    expect(props.onDoubleClick).toHaveBeenCalledWith(breaks[0]);
    expect(props.onLaneDoubleClick).not.toHaveBeenCalled();
    const lane = marker.parentElement!;
    lane.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 20,
      width: 800,
      height: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.dblClick(lane, { clientX: 250 });
    expect(props.onLaneDoubleClick).toHaveBeenCalledWith(12.5);
    expect(screen.getByTestId("break-drag-label")).toHaveTextContent("0:11.5 · 2 notes move");
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
