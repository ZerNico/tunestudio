/**
 * Following a press until it is let go: the part every drag in the editor shares (notes, drawing, line breaks, the
 * selection box). A press that moves less than `DRAG_PX` is a click; past it, every move is reported with how far the
 * pointer went from the press and how far the view scrolled meanwhile (the view scrolls on at the roll's edges). A
 * release ends it with `up`; a cancelled pointer, the window losing focus (the release may never arrive) or `stop`
 * end it without. Each drag keeps its own maths, preview and commit.
 */
import type { AutoScroll } from "./autoscroll";

/** A press that moves less than this is a click, not a drag (px). */
export const DRAG_PX = 3;

export interface DragMove {
  /** From the press (px). */
  dx: number;
  dy: number;
  /** How far the view scrolled since the press (seconds): what is dragged goes along. */
  scrolled: number;
  event: PointerEvent;
}

export function followDrag(options: {
  press: { clientX: number; clientY: number };
  /** Where the pointer events come from (the window, or an element that captured the pointer). */
  target: EventTarget;
  /** Only sideways movement counts towards a drag (a time drag), or any. */
  threshold: "x" | "xy";
  autoScroll?: AutoScroll;
  viewStart?: () => number;
  onMove: (move: DragMove) => void;
  /** Let go; `dragged`: it moved past the threshold. */
  onUp: (dragged: boolean, event: PointerEvent) => void;
  /** It ended, let go or not (before `onUp`): drop the preview. */
  onStop?: () => void;
}): () => void {
  const { press, target } = options;
  const startView = options.viewStart?.() ?? 0;
  let dragging = false;
  const move = (event: Event) => {
    const pointer = event as PointerEvent;
    const dx = pointer.clientX - press.clientX;
    const dy = pointer.clientY - press.clientY;
    if (!dragging && (options.threshold === "x" ? Math.abs(dx) : Math.hypot(dx, dy)) < DRAG_PX) return;
    dragging = true;
    options.autoScroll?.track(pointer.clientX, () => move(event));
    options.onMove({ dx, dy, scrolled: (options.viewStart?.() ?? startView) - startView, event: pointer });
  };
  const stop = () => {
    options.autoScroll?.end();
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", stop);
    target.removeEventListener("blur", stop);
    options.onStop?.();
  };
  const up = (event: Event) => {
    stop();
    options.onUp(dragging, event as PointerEvent);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", stop);
  target.addEventListener("blur", stop);
  return stop;
}
