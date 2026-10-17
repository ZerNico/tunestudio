import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, For, Show } from "solid-js";

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "~/components/ui/context-menu";
import type { AutoScroll } from "~/lib/editor/autoscroll";
import type { BreakDrag } from "~/lib/editor/break-editing";
import { fitCanvas } from "~/lib/editor/canvas";
import type { LineBreak, LineSpan } from "~/lib/editor/chart";
import type { Loop } from "~/lib/editor/loop";
import type { SongMarkers } from "~/lib/editor/song-markers";
import { formatTime, rulerStep, rulerTicks, timeToX, type TimeView, xToTime } from "~/lib/editor/view";
import { loudest, waveColumns } from "~/lib/editor/waveform";
import type { Waveform } from "~/lib/native/types";

import { InlineField } from "./inline-field";
import { breakX, GUTTER_PX } from "./piano-roll";

/** The waveform lane's height (`h-10`). */
const WAVEFORM_PX = 40;
/** A line's text shows only with at least this much room. */
const MIN_TEXT_PX = 24;

/** A lane aligned with the roll: the gutter's room on the left, the content on the right. */
function Lane(props: {
  class?: string;
  testid: string;
  children: JSX.Element;
  /** A double-click on the lane itself (not on what is in it), at `x`. */
  onDoubleClick?: (x: number) => void;
}) {
  return (
    <div class={`flex shrink-0 border-b border-border ${props.class ?? ""}`} data-testid={props.testid}>
      <div class="shrink-0 border-r border-border bg-background" style={{ width: `${GUTTER_PX}px` }} />
      <div
        class="relative min-w-0 flex-1 overflow-hidden"
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
 * Seconds along the top of the roll, with the loop range and the song's markers. A click moves the playhead there; a
 * drag marks a loop range (`loop.ts`), whose edges are dragged to change it and which a double-click removes. The
 * song's start and end (handles, the rest dimmed) and its preview start (a flag) are dragged (`song-markers.ts`).
 */
export function TimeRuler(props: {
  view: TimeView;
  width: number;
  loop: Loop;
  markers: SongMarkers;
  /** The song's length (seconds): where the end handle is when no end is set. */
  length: number;
  autoScroll?: AutoScroll;
}) {
  const startAt = () => props.markers.at("start") ?? 0;
  const endAt = () => props.markers.at("end") ?? props.length;
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
          const { edge, marker } = (event.target as HTMLElement).dataset;
          const x = laneX(event, lane);
          if (marker === "start" || marker === "end" || marker === "preview")
            props.markers.down(marker, xToTime(props.view, x), x);
          else props.loop.down(xToTime(props.view, x), x, edge === "start" || edge === "end" ? edge : null);
        }}
        onPointerMove={(event) => {
          const lane = event.currentTarget;
          if (!lane.hasPointerCapture(event.pointerId)) return;
          // Past the lane's ends it goes to them (and the view scrolls on).
          const move = () => {
            const x = laneX(event, lane);
            if (props.markers.busy()) props.markers.move(xToTime(props.view, x), x);
            else props.loop.move(xToTime(props.view, x), x);
          };
          move();
          props.autoScroll?.track(event.clientX, move);
        }}
        onPointerUp={() => {
          props.autoScroll?.end();
          if (props.markers.busy()) props.markers.up();
          else props.loop.up();
        }}
        onLostPointerCapture={() => {
          props.autoScroll?.end();
          props.markers.cancel();
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
        {/* Before the start and after the end: not played. */}
        <div
          class="pointer-events-none absolute inset-y-0 left-0 bg-background/55"
          style={{ width: `${Math.max(0, timeToX(props.view, startAt()))}px` }}
        />
        <div
          class="pointer-events-none absolute inset-y-0 right-0 bg-background/55"
          style={{ left: `${Math.max(0, timeToX(props.view, endAt()))}px` }}
        />
        <span
          data-marker="start"
          title="Start: the game plays from here (drag to change)"
          class="absolute inset-y-0 w-2.5 cursor-col-resize border-l-2 border-amber-73 data-set:bg-amber-73/25"
          data-set={props.markers.at("start") === null ? undefined : ""}
          style={{ left: `${timeToX(props.view, startAt())}px` }}
          data-testid="marker-start"
        />
        <span
          data-marker="end"
          title="End: the game stops here (drag to change)"
          class="absolute inset-y-0 w-2.5 -translate-x-full cursor-col-resize border-r-2 border-amber-73 data-set:bg-amber-73/25"
          data-set={props.markers.at("end") === null ? undefined : ""}
          style={{ left: `${timeToX(props.view, endAt())}px` }}
          data-testid="marker-end"
        />
        {/* An object, so a preview at 0 s still shows. */}
        <Show when={props.markers.at("preview") === null ? null : { at: props.markers.at("preview")! }}>
          {(preview) => (
            <span
              data-marker="preview"
              title="Preview: the song list plays from here (drag to change)"
              class="absolute top-0 h-full w-2.5 cursor-col-resize bg-amber-73 [clip-path:polygon(0_0,100%_25%,0_50%)]"
              style={{ left: `${timeToX(props.view, preview().at)}px` }}
              data-testid="marker-preview"
            />
          )}
        </Show>
        {/* Over the markers: where a loop edge and a marker meet, the loop edge is what a press takes. */}
        <Show when={props.loop.range()}>
          {(range) => (
            <div
              class="pointer-events-none absolute inset-y-0 border-x border-faint-foreground bg-foreground/8 data-on:border-primary data-on:bg-primary/20"
              data-on={props.loop.on() ? "" : undefined}
              style={{
                left: `${timeToX(props.view, range().start)}px`,
                width: `${(range().end - range().start) * props.view.pxPerSecond}px`,
              }}
              data-testid="loop-range"
            >
              <span data-edge="start" class="pointer-events-auto absolute inset-y-0 -left-1 w-2 cursor-col-resize" />
              <span data-edge="end" class="pointer-events-auto absolute inset-y-0 -right-1 w-2 cursor-col-resize" />
            </div>
          )}
        </Show>
      </div>
    </Lane>
  );
}

/** One break's marker (the trigger of its menu: `trigger` are the menu's props for it). */
function BreakMarker(props: {
  trigger: JSX.HTMLAttributes<HTMLSpanElement>;
  item: LineBreak;
  view: TimeView;
  selected: boolean;
  inactive: boolean;
  onDown: (event: PointerEvent) => void;
  onDoubleClick: () => void;
}) {
  return (
    <span
      {...props.trigger}
      data-singer={props.item.singer}
      data-inactive={props.inactive ? "" : undefined}
      data-auto={props.item.auto ? "" : undefined}
      data-selected={props.selected ? "true" : undefined}
      aria-selected={props.selected ? "true" : "false"}
      title={
        props.item.auto
          ? "Line break (default timing). Drag to move, double-click to remove, right-click for more."
          : "Line break. Drag to move, double-click to remove, right-click for more."
      }
      class="absolute top-1 break-marker h-3 w-2 -translate-x-1/2 cursor-ew-resize rounded-[2px]"
      // Centred on the break's line in the roll.
      style={{ left: `${breakX(props.view, props.item.time) + 0.5}px` }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        props.onDown(event);
      }}
      onDblClick={(event) => {
        event.stopPropagation();
        props.onDoubleClick();
      }}
      data-testid="break-marker"
    />
  );
}

/**
 * The line breaks above the roll, as markers at their switch times (outlined when the chart doesn't store one; singer
 * 2's lighter). A marker is pressed to select and drag it, double-clicked to remove it; a double-click on the lane adds
 * one; right-clicking one resets its timing or removes it. A dragged break is drawn where it would go, with its label.
 */
export function BreakLane(props: {
  breaks: LineBreak[];
  view: TimeView;
  /** The selected breaks, by the line they end. */
  selected: ReadonlySet<number>;
  drag: BreakDrag | null;
  onDown: (item: LineBreak, event: PointerEvent) => void;
  onDoubleClick: (item: LineBreak) => void;
  onLaneDoubleClick: (seconds: number) => void;
  /** Reset timing, from a marker's menu: back to the default rule. */
  onResetTiming: (item: LineBreak) => void;
  /** In a duet, the singer edits go to: the other one's breaks are dimmed. */
  activeSinger?: number;
}) {
  return (
    <Lane class="h-5 bg-bar" testid="break-lane" onDoubleClick={(x) => props.onLaneDoubleClick(xToTime(props.view, x))}>
      <For each={props.breaks} keyed={(item) => item.lineId}>
        {(item) => (
          <ContextMenu>
            <ContextMenuTrigger
              render={(triggerProps: JSX.HTMLAttributes<HTMLSpanElement>) => (
                <BreakMarker
                  trigger={triggerProps}
                  item={item()}
                  view={props.view}
                  selected={props.selected.has(item().lineId)}
                  inactive={props.activeSinger !== undefined && item().singer !== props.activeSinger}
                  onDown={(event) => props.onDown(item(), event)}
                  onDoubleClick={() => props.onDoubleClick(item())}
                />
              )}
            />
            <ContextMenuContent class="min-w-[180px]" data-testid="break-menu">
              <ContextMenuItem disabled={item().auto} onClick={() => props.onResetTiming(item())}>
                Reset timing
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={() => props.onDoubleClick(item())}>
                Remove line break
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
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

/**
 * How loud the vocals (or the song) are under the roll, mirrored around the middle and scaled to the song's loud parts,
 * so where a syllable starts shows. Drawn on a canvas, a column a pixel.
 */
export function WaveformLane(props: { waveform: Waveform; view: TimeView; width: number }) {
  let canvas: HTMLCanvasElement | undefined;
  const scale = createMemo(() => loudest(props.waveform));
  createEffect(
    () => waveColumns(props.waveform, props.view, props.width, scale()),
    (columns) => {
      const context = canvas && fitCanvas(canvas, props.width, WAVEFORM_PX);
      if (!context) return;
      context.fillStyle = getComputedStyle(canvas!).color;
      const middle = WAVEFORM_PX / 2;
      columns.forEach((value, x) => {
        if (value > 0) context.fillRect(x, middle - value * middle, 1, Math.max(1, 2 * value * middle));
      });
    },
  );
  return (
    <Lane class="h-10 bg-bar" testid="waveform-lane">
      <canvas
        ref={(element) => (canvas = element)}
        class="pointer-events-none absolute inset-0 size-full text-muted-foreground opacity-55"
        aria-hidden="true"
      />
    </Lane>
  );
}

/**
 * Each line's text under its notes (singer 2 on a second row in a duet), cut where the next line starts. A double-click
 * on a line's text edits it as text (`line-text.ts`): Enter or leaving the field applies, Esc cancels.
 */
export function LyricsLane(props: {
  lines: LineSpan[];
  all: LineSpan[];
  view: TimeView;
  duet: boolean;
  /** In a duet, the singer edits go to: the other one's text is muted. */
  activeSinger?: number;
  /** The lane's width (px): the text field stays inside it. */
  width: number;
  /** The line being edited as text, and its text. */
  editing?: { lineId: number; text: string } | null;
  onEdit?: (lineId: number) => void;
  /** The typed text (null: cancelled); `fromKey` when Enter applied it (a refused text stays to be fixed). */
  onEditDone?: (text: string | null, fromKey: boolean) => void;
}) {
  /** Where each line's singer's next line starts, by line (worked out once per change, not per line drawn). */
  const nextStarts = createMemo(() => {
    const next = new Map<number, number>();
    const last = new Map<number, LineSpan>();
    for (const line of props.all.toSorted((a, b) => a.start - b.start)) {
      const before = last.get(line.singer);
      if (before) next.set(before.id, line.start);
      last.set(line.singer, line);
    }
    return next;
  });
  const nextStart = (line: LineSpan) => nextStarts().get(line.id) ?? Infinity;
  /** The room for a line's text, up to where the singer's next line starts. */
  const room = (line: LineSpan) =>
    Math.max(0, (Math.min(nextStart(line), line.start + 600) - line.start) * props.view.pxPerSecond - 6);
  /** The line being edited (from every line, not just those in view) and its text. */
  const edited = createMemo(() => {
    const editing = props.editing;
    const line = editing && props.all.find((item) => item.id === editing.lineId);
    return line ? { line, text: editing.text } : null;
  });
  /** The text field: at least 360 px, and inside the lane even where the line starts off its edges. */
  const fieldWidth = (line: LineSpan) => Math.min(Math.max(room(line), 360), Math.max(120, props.width - 8));
  const fieldLeft = (line: LineSpan) =>
    Math.min(Math.max(0, timeToX(props.view, line.start)), Math.max(0, props.width - fieldWidth(line)));
  return (
    <Lane class={props.duet ? "h-11 bg-bar" : "h-7 bg-bar"} testid="lyrics-lane">
      <For each={props.lines}>
        {(line) => (
          <span
            data-singer={line.singer}
            data-row={props.duet && line.singer === 2 ? "2" : undefined}
            data-inactive={props.activeSinger !== undefined && line.singer !== props.activeSinger ? "" : undefined}
            class="absolute top-1.5 cursor-text truncate pl-0.5 text-[11px] leading-4 text-foreground select-none data-inactive:opacity-45 data-[row=2]:top-6 data-[singer=2]:text-violet-text"
            style={{
              left: `${timeToX(props.view, line.start)}px`,
              "max-width": `${room(line)}px`,
            }}
            title="Double-click to edit the line's lyrics"
            onDblClick={() => props.onEdit?.(line.id)}
            data-testid="lyrics-line"
          >
            {/* Too little room for more than a clipped letter. */}
            {room(line) >= MIN_TEXT_PX ? line.text : ""}
          </span>
        )}
      </For>
      {/* Scrolling while typing keeps the field. */}
      <Show when={edited()}>
        {(field) => (
          <InlineField
            class="top-1 h-5 data-[row=2]:top-[22px]"
            data-row={props.duet && field().line.singer === 2 ? "2" : undefined}
            style={{ left: `${fieldLeft(field().line)}px`, width: `${fieldWidth(field().line)}px` }}
            value={field().text}
            label="Line lyrics"
            onDone={(text, exit) => {
              if (exit === "blur" && !props.editing) return;
              props.onEditDone?.(text, exit !== "blur");
            }}
            testid="line-text-input"
          />
        )}
      </Show>
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
  /** In a duet, the singer edits go to: the other one's lines are dimmed. */
  activeSinger?: number;
  /** Centres the view on this time. */
  onScrollTo: (seconds: number) => void;
  /** The medley band (`song-markers.ts`), when the song has one. */
  markers?: SongMarkers;
}) {
  let bar: HTMLDivElement | undefined;
  const percent = (seconds: number) => `${props.length > 0 ? (seconds / props.length) * 100 : 0}%`;
  const at = (clientX: number) => {
    const rect = bar!.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * props.length;
  };
  /** An edge of the band: dragged to the nearest line start or end. */
  const edge = (marker: "medleyStart" | "medleyEnd") => ({
    "data-marker": marker,
    onPointerDown: (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      props.markers?.down(marker);
    },
    onPointerMove: (event: PointerEvent) => {
      if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId))
        props.markers?.move(at(event.clientX));
    },
    onPointerUp: () => props.markers?.up(),
    onLostPointerCapture: () => props.markers?.cancel(),
  });
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
        <For each={props.lines} keyed={(line) => line.id}>
          {/* Keyed: an edit updates its line's block instead of remaking every one. */}
          {(line) => (
            <div
              data-singer={line().singer}
              data-inactive={props.activeSinger !== undefined && line().singer !== props.activeSinger ? "" : undefined}
              class="pointer-events-none absolute h-2 rounded-[2px] bg-primary-line data-inactive:opacity-40 data-[singer=2]:bg-violet-line"
              style={{
                left: percent(line().start),
                width: `max(2px, ${percent(line().duration)})`,
                top: props.duet ? (line().singer === 2 ? "13px" : "4px") : "8px",
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
        <Show
          when={(() => {
            const start = props.markers?.at("medleyStart") ?? null;
            const end = props.markers?.at("medleyEnd") ?? null;
            return start === null || end === null ? null : { start, end };
          })()}
        >
          {(medley) => {
            return (
              <div
                class="pointer-events-none absolute inset-y-0 border-x-2 border-amber-73 bg-amber-33/45"
                style={{ left: percent(medley().start), width: percent(medley().end - medley().start) }}
                title="Medley"
                data-testid="medley-band"
              >
                <span
                  {...edge("medleyStart")}
                  title="Medley start: drag to a line's start"
                  class="pointer-events-auto absolute inset-y-0 -left-1.5 w-2.5 cursor-col-resize"
                />
                <span
                  {...edge("medleyEnd")}
                  title="Medley end: drag to a line's end"
                  class="pointer-events-auto absolute inset-y-0 -right-1.5 w-2.5 cursor-col-resize"
                />
              </div>
            );
          }}
        </Show>
        <div class="pointer-events-none absolute inset-y-0 w-px bg-primary" style={{ left: percent(props.playhead) }} />
      </div>
    </Lane>
  );
}
