import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";

import type { AutoScroll } from "~/lib/editor/autoscroll";
import type { BreakDrag } from "~/lib/editor/break-editing";
import type { LineBreak, LineSpan } from "~/lib/editor/chart";
import type { Loop } from "~/lib/editor/loop";
import { formatTime, rulerStep, rulerTicks, timeToX, type TimeView, xToTime } from "~/lib/editor/view";

import { breakX, GUTTER_PX } from "./piano-roll";

/** A line's text shows only with at least this much room. */
const MIN_TEXT_PX = 24;

/** A lane aligned with the roll: the gutter's room on the left, the content on the right. */
function Lane(props: {
  class?: string;
  testid: string;
  children: JSX.Element;
  onSeek?: (x: number) => void;
  /** A double-click on the lane itself (not on what is in it), at `x`. */
  onDoubleClick?: (x: number) => void;
  /** Scrolls the view while scrubbing at the roll's edge. */
  autoScroll?: AutoScroll;
}) {
  return (
    <div class={`flex shrink-0 border-b border-border ${props.class ?? ""}`} data-testid={props.testid}>
      <div class="shrink-0 border-r border-border bg-background" style={{ width: `${GUTTER_PX}px` }} />
      <div
        class="relative min-w-0 flex-1 overflow-hidden"
        onPointerDown={(event) => {
          if (event.button !== 0 || !props.onSeek) return;
          // Pressing seeks, and dragging on scrubs.
          event.currentTarget.setPointerCapture(event.pointerId);
          props.onSeek(event.clientX - event.currentTarget.getBoundingClientRect().left);
        }}
        onPointerMove={(event) => {
          if (!props.onSeek || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const lane = event.currentTarget;
          // Past the lane's ends it scrubs to them (and the view scrolls on).
          const seek = () =>
            props.onSeek?.(Math.min(lane.clientWidth, Math.max(0, event.clientX - lane.getBoundingClientRect().left)));
          seek();
          props.autoScroll?.track(event.clientX, seek);
        }}
        onPointerUp={() => props.autoScroll?.end()}
        onLostPointerCapture={() => props.autoScroll?.end()}
        onDblClick={(event) => {
          if (props.onDoubleClick && event.target === event.currentTarget)
            props.onDoubleClick(event.clientX - event.currentTarget.getBoundingClientRect().left);
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

/** Where the pointer is on a lane (px), kept to the lane. */
function laneX(event: MouseEvent, lane: HTMLElement): number {
  return Math.min(lane.clientWidth, Math.max(0, event.clientX - lane.getBoundingClientRect().left));
}

/**
 * Seconds along the top of the roll, with the loop range. A click moves the playhead there; a drag marks a loop range
 * (`loop.ts`), whose edges are dragged to change it and which a double-click removes.
 */
export function TimeRuler(props: { view: TimeView; width: number; loop: Loop; autoScroll?: AutoScroll }) {
  const tenths = () => rulerStep(props.view.pxPerSecond) < 1;
  return (
    <Lane class="h-5 bg-bar" testid="time-ruler">
      <div
        class="absolute inset-0 cursor-ew-resize touch-none"
        data-testid="ruler-area"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const lane = event.currentTarget;
          lane.setPointerCapture(event.pointerId);
          const edge = (event.target as HTMLElement).dataset.edge;
          const x = laneX(event, lane);
          props.loop.down(xToTime(props.view, x), x, edge === "start" || edge === "end" ? edge : null);
        }}
        onPointerMove={(event) => {
          const lane = event.currentTarget;
          if (!lane.hasPointerCapture(event.pointerId)) return;
          // Past the lane's ends it goes to them (and the view scrolls on).
          const move = () => {
            const x = laneX(event, lane);
            props.loop.move(xToTime(props.view, x), x);
          };
          move();
          props.autoScroll?.track(event.clientX, move);
        }}
        onPointerUp={() => {
          props.autoScroll?.end();
          props.loop.up();
        }}
        onLostPointerCapture={() => {
          props.autoScroll?.end();
          props.loop.cancel();
        }}
        // The press captures the pointer, so the clicks come here rather than to the range.
        onDblClick={(event) => props.loop.clearAt(xToTime(props.view, laneX(event, event.currentTarget)))}
      >
        <For each={rulerTicks(props.view, props.width)}>
          {(tick) => (
            <span
              class="pointer-events-none absolute top-0 h-full border-l border-border pl-1 font-mono text-[9.5px] leading-5 text-faint-foreground"
              style={{ left: `${timeToX(props.view, tick)}px` }}
            >
              {formatTime(tick, tenths())}
            </span>
          )}
        </For>
        <Show when={props.loop.range()}>
          {(range) => (
            <div
              class="absolute inset-y-0 border-x border-faint-foreground bg-foreground/8 data-on:border-primary data-on:bg-primary/20"
              data-on={props.loop.on() ? "" : undefined}
              style={{
                left: `${timeToX(props.view, range().start)}px`,
                width: `${(range().end - range().start) * props.view.pxPerSecond}px`,
              }}
              title="Loop range: drag its edges to change it, double-click to remove it"
              data-testid="loop-range"
            >
              <span data-edge="start" class="absolute inset-y-0 -left-1 w-2 cursor-col-resize" />
              <span data-edge="end" class="absolute inset-y-0 -right-1 w-2 cursor-col-resize" />
            </div>
          )}
        </Show>
      </div>
    </Lane>
  );
}

/**
 * The line breaks above the roll, as markers at their switch times (fainter when the chart doesn't store one; singer
 * 2's lighter). A marker is pressed to select and drag it, double-clicked to remove it; a double-click on the lane adds
 * one. A dragged break is drawn where it would go, with its label.
 */
export function BreakLane(props: {
  breaks: LineBreak[];
  view: TimeView;
  /** The selected break, by the line it ends. */
  selected: number | null;
  drag: BreakDrag | null;
  onDown: (item: LineBreak, event: PointerEvent) => void;
  onDoubleClick: (item: LineBreak) => void;
  onLaneDoubleClick: (seconds: number) => void;
}) {
  return (
    <Lane class="h-5 bg-bar" testid="break-lane" onDoubleClick={(x) => props.onLaneDoubleClick(xToTime(props.view, x))}>
      <For each={props.breaks} keyed={(item) => item.lineId}>
        {(item) => (
          <span
            data-singer={item().singer}
            data-auto={item().auto ? "" : undefined}
            data-selected={props.selected === item().lineId ? "true" : undefined}
            title={
              item().auto
                ? "Line break (default timing): drag to move, double-click to remove"
                : "Line break: drag to move, double-click to remove"
            }
            class="absolute top-1 h-3 w-2 -translate-x-1/2 cursor-ew-resize rounded-[2px] bg-violet data-auto:opacity-45 data-[singer=2]:bg-violet-text data-selected:opacity-100 data-selected:ring-2 data-selected:ring-foreground"
            // Centred on the break's line in the roll.
            style={{ left: `${breakX(props.view, item().time) + 0.5}px` }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              props.onDown(item(), event);
            }}
            onDblClick={(event) => {
              event.stopPropagation();
              props.onDoubleClick(item());
            }}
            data-testid="break-marker"
          />
        )}
      </For>
      <Show when={props.drag}>
        {(drag) => (
          <span
            class="pointer-events-none absolute top-0 z-10 ml-2 rounded-[3px] border border-tooltip-border bg-tooltip px-1.5 font-mono text-[10px] leading-4 whitespace-nowrap text-foreground"
            style={{ left: `${timeToX(props.view, drag().time)}px` }}
            data-testid="break-drag-label"
          >
            {drag().label}
          </span>
        )}
      </Show>
    </Lane>
  );
}

/** Each line's text under its notes (singer 2 on a second row in a duet), cut where the next line starts. */
export function LyricsLane(props: { lines: LineSpan[]; all: LineSpan[]; view: TimeView; duet: boolean }) {
  const nextStart = (line: LineSpan) =>
    props.all.find((other) => other.singer === line.singer && other.start > line.start)?.start ?? Infinity;
  /** The room for a line's text, up to where the singer's next line starts. */
  const room = (line: LineSpan) =>
    Math.max(0, (Math.min(nextStart(line), line.start + 600) - line.start) * props.view.pxPerSecond - 6);
  return (
    <Lane class={props.duet ? "h-11 bg-bar" : "h-7 bg-bar"} testid="lyrics-lane">
      <For each={props.lines}>
        {(line) => (
          <span
            data-singer={line.singer}
            class="pointer-events-none absolute top-1.5 truncate pl-0.5 text-[11px] leading-4 text-foreground data-[singer=2]:top-6 data-[singer=2]:text-violet-text"
            style={{
              left: `${timeToX(props.view, line.start)}px`,
              "max-width": `${room(line)}px`,
            }}
            data-testid="lyrics-line"
          >
            {/* Too little room for more than a clipped letter. */}
            {room(line) >= MIN_TEXT_PX ? line.text : ""}
          </span>
        )}
      </For>
    </Lane>
  );
}

/**
 * The whole song at a glance: every line as a block, the playhead, and the stretch on screen as a window. Pressing
 * or dragging moves the window there.
 */
export function OverviewBar(props: {
  lines: LineSpan[];
  length: number;
  view: TimeView;
  /** The roll's width, to size the window. */
  width: number;
  playhead: number;
  duet: boolean;
  /** Centres the view on this time. */
  onScrollTo: (seconds: number) => void;
}) {
  let bar: HTMLDivElement | undefined;
  const percent = (seconds: number) => `${props.length > 0 ? (seconds / props.length) * 100 : 0}%`;
  const at = (clientX: number) => {
    const rect = bar!.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * props.length;
  };
  return (
    <Lane class="h-6 bg-bar" testid="overview-bar">
      <div
        ref={(element) => (bar = element)}
        class="absolute inset-0 cursor-pointer"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          props.onScrollTo(at(event.clientX));
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) props.onScrollTo(at(event.clientX));
        }}
      >
        <For each={props.lines}>
          {(line) => (
            <div
              data-singer={line.singer}
              class="pointer-events-none absolute h-2 rounded-[2px] bg-primary-line data-[singer=2]:bg-violet-line"
              style={{
                left: percent(line.start),
                width: `max(2px, ${percent(line.duration)})`,
                top: props.duet ? (line.singer === 2 ? "13px" : "4px") : "8px",
              }}
            />
          )}
        </For>
        <div
          class="pointer-events-none absolute inset-y-0.5 rounded-[3px] border border-primary bg-primary/10"
          style={{
            left: percent(props.view.start),
            width: `max(6px, ${percent(props.width / props.view.pxPerSecond)})`,
          }}
          data-testid="overview-window"
        />
        <div
          class="pointer-events-none absolute inset-y-0 w-px bg-foreground"
          style={{ left: percent(props.playhead) }}
        />
      </div>
    </Lane>
  );
}
