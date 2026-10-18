import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { GUTTER_PX } from "./piano-roll";
import { Playhead } from "./playhead";

const view = { start: 10, pxPerSecond: 100 };

describe("Playhead", () => {
  it("draws the line and head at the time, past the pitch labels", () => {
    render(() => <Playhead view={view} width={800} time={12} onScrub={() => {}} />);
    const line = screen.getByTestId("playhead");
    expect(line.style.left).toBe(`${GUTTER_PX}px`);
    expect(line.style.transform).toBe("translateX(200px)");
    expect(screen.getByTestId("playhead-head")).toHaveAttribute("title", "0:12.0");
  });

  it("isn't drawn when its time is off screen", () => {
    render(() => <Playhead view={view} width={800} time={2} onScrub={() => {}} />);
    expect(screen.queryByTestId("playhead")).not.toBeInTheDocument();
  });

  it("scrubs while its head is dragged", () => {
    const onScrub = vi.fn();
    render(() => (
      <div>
        <Playhead view={view} width={800} time={12} onScrub={onScrub} />
      </div>
    ));
    const head = screen.getByTestId("playhead-head");
    head.parentElement!.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 900,
      bottom: 300,
      width: 900,
      height: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    head.setPointerCapture = vi.fn();
    head.hasPointerCapture = () => true;
    fireEvent.pointerDown(head, { button: 0, pointerId: 1, clientX: GUTTER_PX + 200 });
    fireEvent.pointerMove(head, { pointerId: 1, clientX: GUTTER_PX + 350 });
    expect(onScrub).toHaveBeenLastCalledWith(13.5);
  });
});
