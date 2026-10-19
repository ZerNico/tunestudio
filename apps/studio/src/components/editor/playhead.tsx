import { Show } from "solid-js";

import type { AutoScroll } from "~/lib/editor/autoscroll";
import { formatTime, timeToX, type TimeView, xToTime } from "~/lib/editor/view";

import { GUTTER_PX } from "./piano-roll";

/**
 * The playhead over every lane: a line through the ruler, breaks, roll and lyrics, with a head in the ruler that can
 * be dragged to scrub. Drawn over a `relative` container whose left `GUTTER_PX` are the pitch labels.
 */
export function Playhead(props: {
  view: TimeView;
  width: number;
  time: number;
  onScrub: (seconds: number) => void;
  /** The head is let go. */
  onScrubEnd?: () => void;
  /**
   * A double-click on the head. A click on the ruler moves the head under the pointer, so a double-click on the ruler
   * ends on the head: it is passed on (the loop range there is removed).
   */
  onDoubleClick?: (seconds: number) => void;
  /** Scrolls the view while the head is dragged at the roll's edge. */
  autoScroll?: AutoScroll;
}) {
  const x = () => timeToX(props.view, props.time);
  const shown = () => x() >= -6 && x() <= props.width + 6;
  const scrubTo = (event: PointerEvent, element: HTMLElement) => {
    // The head sits in the container; its left edge plus the gutter is where time 0 of the view is.
    const container = element.parentElement!.getBoundingClientRect();
    props.onScrub(xToTime(props.view, Math.min(props.width, Math.max(0, event.clientX - container.left - GUTTER_PX))));
  };
  /** Moved with a transform, which every playing frame changes without laying the editor out again. */
  const at = () => ({ left: `${GUTTER_PX}px`, transform: `translateX(${x()}px)` });
  return (
    <Show when={shown()}>
      <div class="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary" style={at()} data-testid="playhead" />
      <div
        // A handle for the mouse; the keyboard moves the playhead with Space and the line keys.
        aria-hidden="true"
        title={formatTime(props.time)}
        class="absolute top-0 z-20 h-[15px] w-[13px] -translate-x-1/2 cursor-ew-resize touch-none rounded-t-[3px] bg-primary [clip-path:polygon(0_0,100%_0,100%_62%,50%_100%,0_62%)]"
        style={at()}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const element = event.currentTarget;
          const scrub = () => scrubTo(event, element);
          scrub();
          props.autoScroll?.track(event.clientX, scrub);
        }}
        onPointerUp={() => props.autoScroll?.end()}
        onLostPointerCapture={() => {
          props.autoScroll?.end();
          props.onScrubEnd?.();
        }}
        onDblClick={() => props.onDoubleClick?.(props.time)}
        data-testid="playhead-head"
      />
    </Show>
  );
}
