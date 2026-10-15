import { Show } from "solid-js";

import { formatTime, timeToX, type TimeView, xToTime } from "~/lib/editor/view";

import { GUTTER_PX } from "./piano-roll";

/**
 * The playhead over every lane: a line through the ruler, breaks, roll and lyrics, with a head in the ruler that can
 * be dragged to scrub. Drawn over a `relative` container whose left `GUTTER_PX` are the pitch labels.
 */
export function Playhead(props: { view: TimeView; width: number; time: number; onScrub: (seconds: number) => void }) {
  const x = () => timeToX(props.view, props.time);
  const shown = () => x() >= -6 && x() <= props.width + 6;
  const scrubTo = (event: PointerEvent, element: HTMLElement) => {
    // The head sits in the container; its left edge plus the gutter is where time 0 of the view is.
    const container = element.parentElement!.getBoundingClientRect();
    props.onScrub(xToTime(props.view, Math.min(props.width, Math.max(0, event.clientX - container.left - GUTTER_PX))));
  };
  return (
    <Show when={shown()}>
      <div
        class="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary"
        style={{ left: `${GUTTER_PX + x()}px` }}
        data-testid="playhead"
      />
      <div
        // A handle for the mouse; the keyboard moves the playhead with Space and the line keys.
        aria-hidden="true"
        title={formatTime(props.time)}
        class="absolute top-0 z-20 h-[15px] w-[13px] -translate-x-1/2 cursor-ew-resize touch-none rounded-t-[3px] bg-primary [clip-path:polygon(0_0,100%_0,100%_62%,50%_100%,0_62%)]"
        style={{ left: `${GUTTER_PX + x()}px` }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) scrubTo(event, event.currentTarget);
        }}
        data-testid="playhead-head"
      />
    </Show>
  );
}
