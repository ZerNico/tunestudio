/**
 * Scrolling while dragging: a drag (a note, a line break, a selection box, the playhead) that comes near the roll's
 * left or right edge, or goes past it, scrolls the view that way, faster the further in, and is redone at the
 * pointer each frame so what is dragged keeps up with it. Drags report their pointer with `track` and stop with `end`.
 */

/** How close to an edge (px) the pointer has to be for the view to scroll. */
export const EDGE_PX = 40;
/** The fastest it scrolls (px a frame), reached at the edge and beyond. */
const MAX_SPEED_PX = 24;

export interface AutoScroll {
  /** The pointer is at `clientX` in a drag; `redo` redoes the drag there after the view scrolled. */
  track: (clientX: number, redo: () => void) => void;
  /** The drag ended. */
  end: () => void;
}

/** How far a frame scrolls (px, negative to the left) with the pointer at `x` over `bounds`. */
export function scrollSpeed(bounds: { left: number; right: number }, x: number): number {
  const into = (depth: number) => Math.min(MAX_SPEED_PX, (Math.max(0, depth) / EDGE_PX) * MAX_SPEED_PX);
  if (x < bounds.left + EDGE_PX) return -into(bounds.left + EDGE_PX - x);
  if (x > bounds.right - EDGE_PX) return into(x - (bounds.right - EDGE_PX));
  return 0;
}

export function createAutoScroll(options: {
  /** The roll's drawing area on screen (null: not there). */
  bounds: () => { left: number; right: number } | null;
  /** Scrolls the view by `px` (it stops at the song's ends). */
  scroll: (px: number) => void;
  frame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}): AutoScroll {
  const frame = options.frame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  let x = 0;
  let redo: (() => void) | null = null;
  let pending: number | null = null;

  const speed = () => {
    const bounds = options.bounds();
    return bounds ? scrollSpeed(bounds, x) : 0;
  };
  const tick = () => {
    pending = null;
    const step = speed();
    if (step === 0 || !redo) return;
    options.scroll(step);
    // The redo reports the pointer again (`track`), which may already have asked for the next frame.
    redo();
    pending ??= frame(tick);
  };

  return {
    track(clientX, next) {
      x = clientX;
      redo = next;
      if (pending === null && speed() !== 0) pending = frame(tick);
    },
    end() {
      redo = null;
      if (pending !== null) cancelFrame(pending);
      pending = null;
    },
  };
}
