import { describe, expect, it, vi } from "vitest";

import { DRAG_PX, followDrag } from "./drag";

const pointer = (type: string, clientX = 0, clientY = 0) => Object.assign(new Event(type), { clientX, clientY });

function setup(threshold: "x" | "xy", viewStart?: () => number) {
  const target = new EventTarget();
  const onMove = vi.fn();
  const onUp = vi.fn();
  const onStop = vi.fn();
  const stop = followDrag({
    press: { clientX: 100, clientY: 100 },
    target,
    threshold,
    viewStart,
    onMove,
    onUp,
    onStop,
  });
  return { target, onMove, onUp, onStop, stop };
}

describe("following a drag", () => {
  it("is a click until the pointer moves past the threshold, then reports every move", () => {
    const { target, onMove, onUp } = setup("xy");
    target.dispatchEvent(pointer("pointermove", 101, 101));
    expect(onMove).not.toHaveBeenCalled();
    target.dispatchEvent(pointer("pointermove", 100 + DRAG_PX, 100));
    expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ dx: DRAG_PX, dy: 0, scrolled: 0 }));
    target.dispatchEvent(pointer("pointerup"));
    expect(onUp).toHaveBeenCalledWith(true, expect.anything());
  });

  it("counts only sideways movement for a time drag, and reports how far the view scrolled", () => {
    let start = 2;
    const { target, onMove, onUp } = setup("x", () => start);
    target.dispatchEvent(pointer("pointermove", 100, 140));
    expect(onMove).not.toHaveBeenCalled();
    start = 3.5;
    target.dispatchEvent(pointer("pointermove", 110, 140));
    expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ dx: 10, scrolled: 1.5 }));
    target.dispatchEvent(pointer("pointerup"));
    expect(onUp).toHaveBeenCalledWith(true, expect.anything());
  });

  it("ends without a release when cancelled, stopped or the window loses focus, and then hears nothing", () => {
    for (const end of ["pointercancel", "blur", "stop"] as const) {
      const { target, onMove, onUp, onStop, stop } = setup("xy");
      if (end === "stop") stop();
      else target.dispatchEvent(new Event(end));
      expect(onStop).toHaveBeenCalledTimes(1);
      target.dispatchEvent(pointer("pointermove", 200, 200));
      target.dispatchEvent(pointer("pointerup"));
      expect(onMove).not.toHaveBeenCalled();
      expect(onUp).not.toHaveBeenCalled();
    }
  });

  it("calls a press let go without moving a click", () => {
    const { target, onUp } = setup("xy");
    target.dispatchEvent(pointer("pointerup"));
    expect(onUp).toHaveBeenCalledWith(false, expect.anything());
  });
});
