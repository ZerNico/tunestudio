import { createSignal, For, Show } from "solid-js";

import type { DrawnNote, LineBreak } from "~/lib/editor/chart";
import { type DragPreview, type NotePart, previewed, type RollScale } from "~/lib/editor/note-editing";
import {
  type PitchRange,
  pitchName,
  pitchToY,
  rowCount,
  timeToX,
  type TimeView,
  xToTime,
  yToPitch,
} from "~/lib/editor/view";
import type { NoteType, SungPitch } from "~/lib/native/types";

import { PitchTrace } from "./pitch-trace";

/** Notes narrower than this show no syllable (it would only be a clipped letter). */
const MIN_LABEL_PX = 18;

const TYPE_NAMES: Record<NoteType, string> = {
  normal: "",
  golden: "golden",
  rap: "rap",
  "golden-rap": "golden rap",
  freestyle: "freestyle",
};

/** The tooltip: syllable, pitch, the type when it isn't normal, and a problem. */
function noteTitle(note: DrawnNote, overlaps: boolean): string {
  return [
    note.lyric.trim() || "–",
    pitchName(note.pitch),
    TYPE_NAMES[note.type],
    overlaps ? "⚠ overlaps another note" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The label: ⚠ for a problem, then the syllable. */
function noteLabel(note: DrawnNote, overlaps: boolean): string {
  return `${overlaps ? "⚠ " : ""}${note.lyric}`;
}

/** How wide the pitch labels at the roll's left are; the other lanes leave the same room. */
export const GUTTER_PX = 40;

/** Notes narrower than this have no resize edges: a press anywhere moves them (px). */
const MIN_EDGES_PX = 12;

/** A press that moves less than this is a click, not a drag (px). */
const DRAG_PX = 3;

/** What a selection box covers: seconds and pitches, both inclusive. */
export interface SelectionBox {
  from: number;
  to: number;
  low: number;
  high: number;
}

/**
 * The notes on screen against time and pitch: rows per semitone (C rows a little lighter, labelled every C and E),
 * each note a bar with its syllable, line breaks dashed at their switch times (fainter when the chart doesn't store
 * one). Only what is in view is given; the playhead is drawn over all lanes (`Playhead`).
 *
 * Notes look as `roll-note` (styles.css) says: selected ones lime with resize grips, overlapping ones a red border and
 * ⚠, rap ones italic. A click on empty space is `onEmptyClick` (at
 * its time); a drag there draws a selection box (`onBox`, with whether Shift or Cmd/Ctrl added to the selection).
 */
export function PianoRoll(props: {
  notes: DrawnNote[];
  breaks: LineBreak[];
  /** What is sung, drawn behind the notes (null: not shown). */
  pitch?: SungPitch | null;
  range: PitchRange;
  view: TimeView;
  /** The drawing area (without the gutter). */
  width: number;
  height: number;
  selected: ReadonlySet<number>;
  overlapping: ReadonlySet<number>;
  onNoteDown: (note: DrawnNote, event: PointerEvent, part: NotePart, scale: RollScale) => void;
  /** A drag in progress: its notes are drawn where it has moved them, with its label. */
  drag?: DragPreview | null;
  onEmptyClick: (seconds: number) => void;
  onBox: (box: SelectionBox, add: boolean) => void;
}) {
  const rowHeight = () => props.height / rowCount(props.range);
  /** Where the drag's label goes: just above the pressed note, as it is drawn now. */
  const dragLabel = () => {
    const drag = props.drag;
    const pressed = drag && props.notes.find((note) => note.id === drag.anchor);
    if (!drag || !pressed) return null;
    const shown = previewed(pressed, drag);
    return {
      text: drag.label,
      x: timeToX(props.view, shown.start),
      y: Math.max(0, pitchToY(props.range, rowHeight(), shown.pitch) - 18),
    };
  };
  /** The selection box being drawn, in px from the drawing area's corner. */
  const [box, setBox] = createSignal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const startBox = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    const area = event.currentTarget;
    const rect = area.getBoundingClientRect();
    const at = (pointer: PointerEvent) => ({ x: pointer.clientX - rect.left, y: pointer.clientY - rect.top });
    const start = at(event);
    let dragging = false;
    area.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const now = at(pointer);
      if (!dragging && Math.hypot(now.x - start.x, now.y - start.y) < DRAG_PX) return;
      dragging = true;
      setBox({ x0: start.x, y0: start.y, x1: now.x, y1: now.y });
    };
    const up = (pointer: PointerEvent) => {
      area.removeEventListener("pointermove", move);
      area.removeEventListener("pointerup", up);
      area.removeEventListener("pointercancel", up);
      const drawn = box();
      setBox(null);
      if (!dragging || !drawn || pointer.type === "pointercancel") {
        if (!dragging) props.onEmptyClick(xToTime(props.view, start.x));
        return;
      }
      const [left, right] = [Math.min(drawn.x0, drawn.x1), Math.max(drawn.x0, drawn.x1)];
      const [top, bottom] = [Math.min(drawn.y0, drawn.y1), Math.max(drawn.y0, drawn.y1)];
      props.onBox(
        {
          from: xToTime(props.view, left),
          to: xToTime(props.view, right),
          low: yToPitch(props.range, rowHeight(), bottom),
          high: yToPitch(props.range, rowHeight(), top),
        },
        pointer.shiftKey || pointer.metaKey || pointer.ctrlKey,
      );
    };
    area.addEventListener("pointermove", move);
    area.addEventListener("pointerup", up);
    area.addEventListener("pointercancel", up);
  };
  const rows = () => {
    const pitches: number[] = [];
    for (let pitch = props.range.high; pitch >= props.range.low; pitch--) pitches.push(pitch);
    return pitches;
  };
  return (
    <div class="relative flex min-h-0 flex-1" data-testid="piano-roll">
      <div class="relative shrink-0 border-r border-border bg-background" style={{ width: `${GUTTER_PX}px` }}>
        <For each={rows()}>
          {(pitch, i) => (
            <span
              class="absolute right-1.5 font-mono text-[9px] leading-none text-faint-foreground"
              style={{ top: `${i() * rowHeight() + rowHeight() / 2 - 4}px` }}
              hidden={pitch % 12 !== 0 && pitch % 12 !== 4}
            >
              {pitchName(pitch)}
            </span>
          )}
        </For>
      </div>
      <div
        class="relative min-w-0 flex-1 overflow-hidden bg-background"
        data-testid="roll-area"
        onPointerDown={(event) => {
          if (event.button !== 0 || event.target !== event.currentTarget) return;
          startBox(event);
        }}
      >
        <For each={rows()}>
          {(pitch, i) => (
            <div
              data-c={pitch % 12 === 0 ? "" : undefined}
              class="pointer-events-none absolute inset-x-0 border-b border-border-soft even:bg-sage-11 data-c:bg-sage-13"
              style={{ top: `${i() * rowHeight()}px`, height: `${rowHeight()}px` }}
            />
          )}
        </For>
        <Show when={props.pitch}>
          {(pitch) => (
            <PitchTrace
              pitch={pitch()}
              view={props.view}
              width={props.width}
              height={props.height}
              range={props.range}
            />
          )}
        </Show>
        <For each={props.breaks}>
          {(item) => (
            <div
              data-singer={item.singer}
              data-auto={item.auto ? "" : undefined}
              class="pointer-events-none absolute inset-y-0 border-l border-dashed border-violet data-auto:opacity-45 data-[singer=2]:border-violet-text"
              style={{ left: `${timeToX(props.view, item.time)}px` }}
              data-testid="line-break"
            />
          )}
        </For>
        <For each={props.notes}>
          {(note) => {
            /** Where the note is drawn: moved along while it is dragged. */
            const shown = () => previewed(note, props.drag ?? null);
            const widthPx = () => shown().duration * props.view.pxPerSecond;
            const press = (event: PointerEvent, part: NotePart) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              props.onNoteDown(note, event, part, { pxPerSecond: props.view.pxPerSecond, rowHeight: rowHeight() });
            };
            return (
              <div
                data-singer={note.singer}
                data-type={note.type}
                data-selected={props.selected.has(note.id) ? "true" : undefined}
                data-overlap={props.overlapping.has(note.id) ? "" : undefined}
                aria-selected={props.selected.has(note.id) ? "true" : "false"}
                title={noteTitle(note, props.overlapping.has(note.id))}
                onPointerDown={(event) => press(event, "body")}
                class="roll-note cursor-grab"
                style={{
                  left: `${timeToX(props.view, shown().start)}px`,
                  width: `${Math.max(2, widthPx() - 1)}px`,
                  top: `${pitchToY(props.range, rowHeight(), shown().pitch) + 1}px`,
                  height: `${Math.max(4, rowHeight() - 2)}px`,
                  "line-height": `${Math.max(4, rowHeight() - 2)}px`,
                }}
                data-testid="roll-note"
              >
                {/* Too narrow for a readable syllable: the title still names it. */}
                {widthPx() >= MIN_LABEL_PX ? noteLabel(note, props.overlapping.has(note.id)) : ""}
                {/* Edges move the start or end; a note too narrow for them is only moved. */}
                <Show when={widthPx() >= MIN_EDGES_PX}>
                  <span
                    class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize"
                    onPointerDown={(event) => press(event, "start")}
                    data-testid="note-start-edge"
                  />
                  <span
                    class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize"
                    onPointerDown={(event) => press(event, "end")}
                    data-testid="note-end-edge"
                  />
                </Show>
              </div>
            );
          }}
        </For>
        <Show when={dragLabel()}>
          {(label) => (
            <div
              class="pointer-events-none absolute z-30 rounded-[3px] border border-tooltip-border bg-tooltip px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-foreground"
              style={{ left: `${label().x}px`, top: `${label().y}px` }}
              data-testid="drag-label"
            >
              {label().text}
            </div>
          )}
        </Show>
        <Show when={box()}>
          {(drawn) => (
            <div
              class="pointer-events-none absolute z-20 border border-primary bg-primary/10"
              style={{
                left: `${Math.min(drawn().x0, drawn().x1)}px`,
                top: `${Math.min(drawn().y0, drawn().y1)}px`,
                width: `${Math.abs(drawn().x1 - drawn().x0)}px`,
                height: `${Math.abs(drawn().y1 - drawn().y0)}px`,
              }}
              data-testid="selection-box"
            />
          )}
        </Show>
      </div>
    </div>
  );
}
