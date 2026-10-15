import type { JSX } from "@solidjs/web";
import { For } from "solid-js";

import type { LineBreak, LineSpan } from "~/lib/editor/chart";
import { formatTime, rulerStep, rulerTicks, timeToX, type TimeView, xToTime } from "~/lib/editor/view";

import { GUTTER_PX } from "./piano-roll";

/** A line's text shows only with at least this much room. */
const MIN_TEXT_PX = 24;

/** A lane aligned with the roll: the gutter's room on the left, the content on the right. */
function Lane(props: { class?: string; testid: string; children: JSX.Element; onSeek?: (x: number) => void }) {
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
          if (props.onSeek && event.currentTarget.hasPointerCapture(event.pointerId)) {
            props.onSeek(event.clientX - event.currentTarget.getBoundingClientRect().left);
          }
        }}
      >
        {props.children}
      </div>
    </div>
  );
}

/** Seconds along the top of the roll; clicking it moves the playhead there. */
export function TimeRuler(props: { view: TimeView; width: number; onSeek: (seconds: number) => void }) {
  const tenths = () => rulerStep(props.view.pxPerSecond) < 1;
  return (
    <Lane class="h-5 cursor-ew-resize bg-bar" testid="time-ruler" onSeek={(x) => props.onSeek(xToTime(props.view, x))}>
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
    </Lane>
  );
}

/**
 * The handles of the line breaks above the roll: one per break at its switch time, fainter when the chart doesn't
 * store one. (They become draggable when lines can be edited.)
 */
export function BreakLane(props: { breaks: LineBreak[]; view: TimeView }) {
  return (
    <Lane class="h-3.5 bg-bar" testid="break-lane">
      <For each={props.breaks}>
        {(item) => (
          <span
            data-singer={item.singer}
            data-auto={item.auto ? "" : undefined}
            title={item.auto ? "Line break (default timing)" : "Line break"}
            class="absolute top-0.5 h-2.5 w-1.5 -translate-x-1/2 rounded-[2px] bg-violet data-auto:opacity-45 data-[singer=2]:bg-violet-text"
            style={{ left: `${timeToX(props.view, item.time)}px` }}
          />
        )}
      </For>
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
