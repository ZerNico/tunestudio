import { createSignal, For, Show } from "solid-js";

import type { AutoScroll } from "~/lib/editor/autoscroll";
import type { DrawnNote, LineBreak } from "~/lib/editor/chart";
import { followDrag } from "~/lib/editor/drag";
import { type DragPreview, type NotePart, previewed, type RollScale } from "~/lib/editor/note-editing";
import type { Tool } from "~/lib/editor/tools";
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

import { InlineField } from "./inline-field";
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

/** Rows at least this tall (px) get every pitch's name; thinner ones only the C's. */
const LABEL_ALL_PX = 14;
/** Pitch classes of the black keys (named as sharps), whose names are dimmer. */
const SHARPS = new Set([1, 3, 6, 8, 10]);

/** How wide the pitch labels at the roll's left are; the other lanes leave the same room. */
export const GUTTER_PX = 40;

/**
 * Where a break's 1 px line is drawn: just before its time. A note is drawn 1 px short of its end, so a break at a
 * note's start or end sits right outside it either way.
 */
export const breakX = (view: TimeView, time: number) => timeToX(view, time) - 1;

/** Notes narrower than this have no resize edges: a press anywhere moves them (px). */
const MIN_EDGES_PX = 12;

/** A selection box being drawn: from where it started (seconds, px down) to the pointer. */
interface Box {
  t0: number;
  y0: number;
  t1: number;
  y1: number;
}

/** A point in the roll: seconds and pitch. */
export interface RollPoint {
  time: number;
  pitch: number;
}

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
 * ⚠, rap ones italic. What a press does depends on the tool: with Select a click on empty space is `onEmptyClick` (at
 * its time) and a drag there draws a selection box (`onBox`, with whether Shift or Cmd/Ctrl added to the selection);
 * with Draw a press there is `onDrawDown`; with Split a press on a note cuts it where `cut` shows (`onSplit`). A
 * double-click on empty space adds a note, on a note types its syllable (`editingLyric`).
 */
export function PianoRoll(props: {
  notes: DrawnNote[];
  breaks: LineBreak[];
  /** In a duet, the singer edits go to: the other one's notes and breaks are dimmed, and below where they overlap. */
  activeSinger?: number;
  /** What is sung, drawn behind the notes (null: not shown). */
  pitch?: SungPitch | null;
  /** What is sung into the microphone while singing along, drawn like the sung pitch in its own colour. */
  voice?: SungPitch | null;
  range: PitchRange;
  view: TimeView;
  /** The drawing area (without the gutter). */
  width: number;
  height: number;
  selected: ReadonlySet<number>;
  /** The selected line breaks, by the line they end: drawn solid, in the selection's colour. */
  selectedBreaks?: ReadonlySet<number>;
  /** A press on a line break's line (Select tool), as on its marker above the roll. */
  onBreakDown?: (item: LineBreak, event: PointerEvent) => void;
  overlapping: ReadonlySet<number>;
  /** Where the game starts and stops playing (seconds; null: the song's start or end): outside is dimmed. */
  played?: { start: number | null; end: number | null };
  /** Notes auto pitch is working on. */
  pending?: ReadonlySet<number>;
  onNoteDown: (note: DrawnNote, event: PointerEvent, part: NotePart, scale: RollScale) => void;
  /** A drag in progress: its notes are drawn where it has moved them, with its label. */
  drag?: DragPreview | null;
  onEmptyClick: (seconds: number) => void;
  onBox: (box: SelectionBox, add: boolean) => void;
  tool: Tool;
  onDrawDown: (at: RollPoint, event: PointerEvent, scale: RollScale) => void;
  /** A note being drawn, drawn faintly. */
  drawing?: { start: number; duration: number; pitch: number } | null;
  onEmptyDoubleClick: (at: RollPoint) => void;
  /** Split tool: where the note under the pointer would be cut. */
  cut?: { noteId: number; time: number; valid: boolean } | null;
  onHover: (note: DrawnNote | null, seconds: number) => void;
  onSplit: (note: DrawnNote, seconds: number, every: boolean) => void;
  onNoteDoubleClick: (note: DrawnNote) => void;
  /** A right-click on a note (the note menu opens; see `note-menu.tsx`). */
  onNoteContextMenu?: (note: DrawnNote) => void;
  /** The note whose syllable is being typed, and what to do with the text (null: cancelled; Tab moves on). */
  editingLyric?: number | null;
  /** That note, from all of them (not only those in view). */
  lyricNote?: DrawnNote | null;
  onLyricDone: (text: string | null, move?: 1 | -1) => void;
  /** Scrolls the view while the selection box is at the roll's edge. */
  autoScroll?: AutoScroll;
}) {
  let area: HTMLDivElement | undefined;
  /** The time and pitch under a pointer. */
  const pointAt = (event: { clientX: number; clientY: number }): RollPoint => {
    const rect = area!.getBoundingClientRect();
    return {
      time: xToTime(props.view, event.clientX - rect.left),
      pitch: yToPitch(props.range, rowHeight(), event.clientY - rect.top),
    };
  };
  const scale = (): RollScale => ({
    pxPerSecond: props.view.pxPerSecond,
    rowHeight: rowHeight(),
    // Read when asked, so a drag sees the rows as they are then.
    pitchAt: (clientY) => props.range.high + 0.5 - (clientY - area!.getBoundingClientRect().top) / rowHeight(),
    rows: () => props.range,
  });
  const rowHeight = () => props.height / rowCount(props.range);
  const inactive = (singer: number) =>
    props.activeSinger !== undefined && singer !== props.activeSinger ? "" : undefined;
  /** Where the drag's label goes: just above the pressed note, as it is drawn now. */
  const dragLabel = () => {
    const drag = props.drag;
    const anchor = drag && "note" in drag.anchor ? drag.anchor.note : null;
    const pressed = props.notes.find((note) => note.id === anchor);
    if (!drag || !pressed) return null;
    const shown = previewed(pressed, drag);
    return {
      text: drag.label,
      x: timeToX(props.view, shown.start),
      y: Math.max(0, pitchToY(props.range, rowHeight(), shown.pitch) - 18),
    };
  };
  /** The Split tool's cut line: across the hovered note's row, at the cut. */
  const cutLine = () => {
    const cut = props.cut;
    const note = cut && props.notes.find((item) => item.id === cut.noteId);
    if (!cut || !note || props.tool !== "split") return null;
    return {
      x: timeToX(props.view, cut.time),
      y: pitchToY(props.range, rowHeight(), note.pitch) - 2,
      height: rowHeight() + 2,
      valid: cut.valid,
    };
  };
  /**
   * Where the syllable being typed is edited: over its note, at least wide enough to type in, and inside the roll when
   * the note scrolls out of view (the field stays: typing goes on).
   */
  const lyricField = () => {
    const note = props.lyricNote;
    if (!note || note.id !== props.editingLyric) return null;
    const width = Math.max(80, note.duration * props.view.pxPerSecond);
    return {
      lyric: note.lyric,
      x: Math.min(Math.max(0, timeToX(props.view, note.start)), Math.max(0, props.width - width)),
      y: pitchToY(props.range, rowHeight(), note.pitch),
      width,
      height: Math.max(18, rowHeight()),
    };
  };
  /** The selection box being drawn, in px from the drawing area's corner. */
  const [box, setBox] = createSignal<Box | null>(null);

  const startBox = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    const area = event.currentTarget;
    const rect = area.getBoundingClientRect();
    /** The pointer in the area: seconds (in the view; at its edge when past it, while the view scrolls) and px down. */
    const at = (pointer: PointerEvent) => ({
      time: xToTime(props.view, Math.min(props.width, Math.max(0, pointer.clientX - rect.left))),
      y: pointer.clientY - rect.top,
    });
    /** Where the box started: taken once, at the press. */
    const initialPoint = at(event);
    /** The box as last drawn (the signal is written on the next microtask; a release can come first). */
    let drawn: Box | null = null;
    let dragging = false;
    area.setPointerCapture(event.pointerId);
    /** Esc drops the box (and goes no further: it isn't a deselect or a tool change). */
    const escape = (key: KeyboardEvent) => {
      if (key.key !== "Escape" || !dragging) return;
      key.preventDefault();
      key.stopImmediatePropagation();
      stop();
    };
    const stop = followDrag({
      press: event,
      target: area,
      threshold: "xy",
      autoScroll: props.autoScroll,
      onMove: ({ event: pointer }) => {
        dragging = true;
        const now = at(pointer);
        drawn = { t0: initialPoint.time, y0: initialPoint.y, t1: now.time, y1: now.y };
        setBox(drawn);
      },
      onStop: () => {
        window.removeEventListener("keydown", escape, true);
        setBox(null);
      },
      onUp: (dragged, pointer) => {
        if (!dragged || !drawn) {
          props.onEmptyClick(initialPoint.time);
          return;
        }
        const [top, bottom] = [Math.min(drawn.y0, drawn.y1), Math.max(drawn.y0, drawn.y1)];
        props.onBox(
          {
            from: Math.min(drawn.t0, drawn.t1),
            to: Math.max(drawn.t0, drawn.t1),
            low: yToPitch(props.range, rowHeight(), bottom),
            high: yToPitch(props.range, rowHeight(), top),
          },
          pointer.shiftKey || pointer.metaKey || pointer.ctrlKey,
        );
      },
    });
    window.addEventListener("keydown", escape, true);
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
              class="absolute right-1.5 font-mono text-[9px] leading-none text-faint-foreground data-c:text-muted-foreground data-sharp:opacity-55"
              style={{ top: `${i() * rowHeight() + rowHeight() / 2 - 4}px` }}
              data-c={pitch % 12 === 0 ? "" : undefined}
              data-sharp={SHARPS.has(pitch % 12) ? "" : undefined}
              // Every row's name when there is room for it, else the octaves' (C).
              hidden={rowHeight() < LABEL_ALL_PX && pitch % 12 !== 0}
              data-testid="pitch-label"
            >
              {pitchName(pitch)}
            </span>
          )}
        </For>
      </div>
      <div
        class="relative min-w-0 flex-1 overflow-hidden bg-background"
        data-testid="roll-area"
        data-tool={props.tool}
        ref={(element) => (area = element)}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.target !== event.currentTarget) return;
          if (props.tool === "draw") props.onDrawDown(pointAt(event), event, scale());
          else startBox(event);
        }}
        onDblClick={(event) => {
          if (event.target === event.currentTarget) props.onEmptyDoubleClick(pointAt(event));
        }}
      >
        <For each={rows()}>
          {(pitch, i) => (
            <div
              data-c={pitch % 12 === 0 ? "" : undefined}
              data-testid="roll-row"
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
        <Show when={props.voice}>
          {(voice) => (
            <PitchTrace
              pitch={voice()}
              kind="voice"
              view={props.view}
              width={props.width}
              height={props.height}
              range={props.range}
            />
          )}
        </Show>
        <For each={props.breaks}>
          {(item) => (
            <>
              <div
                data-singer={item.singer}
                data-inactive={inactive(item.singer)}
                data-auto={item.auto ? "" : undefined}
                data-selected={props.selectedBreaks?.has(item.lineId) ? "true" : undefined}
                class="pointer-events-none absolute inset-y-0 roll-break"
                style={{ left: `${breakX(props.view, item.time)}px` }}
                data-testid="line-break"
              />
              {/*
                The line is pressed and dragged as its marker is (with Select), in a narrow strip that leaves the gap
                to the roll; notes, drawn later, stay on top. A double-click there adds a note. The other singer's grip
                goes under the active singer's grips and notes.
              */}
              <Show when={props.tool === "select" && props.onBreakDown}>
                <div
                  data-singer={item.singer}
                  data-inactive={inactive(item.singer)}
                  class="absolute inset-y-0 z-[1] w-1 -translate-x-1/2 cursor-ew-resize data-inactive:z-0"
                  style={{ left: `${breakX(props.view, item.time) + 0.5}px` }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.stopPropagation();
                    props.onBreakDown?.(item, event);
                  }}
                  onDblClick={(event) => {
                    event.stopPropagation();
                    props.onEmptyDoubleClick(pointAt(event));
                  }}
                  data-testid="line-break-grip"
                />
              </Show>
            </>
          )}
        </For>
        <Show when={props.played?.start != null && timeToX(props.view, props.played.start) > 0}>
          <div
            class="pointer-events-none absolute inset-y-0 left-0 z-[5] bg-background/45"
            style={{ width: `${timeToX(props.view, props.played!.start!)}px` }}
            data-testid="not-played-before"
          />
        </Show>
        <Show when={props.played?.end != null && timeToX(props.view, props.played.end) < props.width}>
          <div
            class="pointer-events-none absolute inset-y-0 right-0 z-[5] bg-background/45"
            style={{ left: `${Math.max(0, timeToX(props.view, props.played!.end!))}px` }}
            data-testid="not-played-after"
          />
        </Show>
        <For each={props.notes} keyed={(item) => item.id}>
          {(note) => {
            // Keyed by id: an edit (which makes new note objects) updates the element instead of making a new one.
            /** Where the note is drawn: moved along while it is dragged. */
            const shown = () => previewed(note(), props.drag ?? null);
            const widthPx = () => shown().duration * props.view.pxPerSecond;
            const press = (event: PointerEvent, part: NotePart) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              if (props.tool === "split") props.onSplit(note(), pointAt(event).time, event.shiftKey);
              else props.onNoteDown(note(), event, part, scale());
            };
            return (
              <div
                data-singer={note().singer}
                data-inactive={inactive(note().singer)}
                data-type={note().type}
                data-selected={props.selected.has(note().id) ? "true" : undefined}
                data-overlap={props.overlapping.has(note().id) ? "" : undefined}
                data-pending={props.pending?.has(note().id) ? "" : undefined}
                aria-selected={props.selected.has(note().id) ? "true" : "false"}
                title={noteTitle(note(), props.overlapping.has(note().id))}
                onPointerDown={(event) => press(event, "body")}
                onPointerMove={(event) => {
                  if (props.tool === "split") props.onHover(note(), pointAt(event).time);
                }}
                onPointerLeave={() => props.onHover(null, 0)}
                onDblClick={(event) => {
                  event.stopPropagation();
                  props.onNoteDoubleClick(note());
                }}
                onContextMenu={() => props.onNoteContextMenu?.(note())}
                data-tool={props.tool}
                class="roll-note cursor-grab data-[tool=split]:cursor-scissors"
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
                {widthPx() >= MIN_LABEL_PX ? noteLabel(note(), props.overlapping.has(note().id)) : ""}
                {/* Edges move the start or end; a note too narrow for them is only moved. */}
                <Show when={widthPx() >= MIN_EDGES_PX && props.tool !== "split"}>
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
        <Show when={props.drawing}>
          {(drawn) => (
            <div
              class="pointer-events-none roll-note opacity-70"
              data-selected="true"
              style={{
                left: `${timeToX(props.view, drawn().start)}px`,
                width: `${Math.max(2, drawn().duration * props.view.pxPerSecond - 1)}px`,
                top: `${pitchToY(props.range, rowHeight(), drawn().pitch) + 1}px`,
                height: `${Math.max(4, rowHeight() - 2)}px`,
              }}
              data-testid="drawing-note"
            />
          )}
        </Show>
        <Show when={cutLine()}>
          {(line) => (
            <div
              class="pointer-events-none absolute z-20 w-0.5 -translate-x-1/2 rounded-full bg-foreground data-invalid:bg-destructive"
              data-invalid={line().valid ? undefined : ""}
              style={{ left: `${line().x}px`, top: `${line().y}px`, height: `${line().height}px` }}
              data-testid="split-cut"
            />
          )}
        </Show>
        <Show when={lyricField()}>
          {(field) => (
            <InlineField
              style={{
                left: `${field().x}px`,
                top: `${field().y}px`,
                width: `${field().width}px`,
                height: `${field().height}px`,
              }}
              value={field().lyric}
              label="Syllable"
              tabs
              onDone={(text, exit) => {
                // Leaving it after Enter or Tab closed it changes nothing.
                if (exit === "blur" && (props.editingLyric === null || props.editingLyric === undefined)) return;
                if (exit === "tab" || exit === "shift-tab") props.onLyricDone(text, exit === "tab" ? 1 : -1);
                else props.onLyricDone(text);
              }}
              testid="lyric-input"
            />
          )}
        </Show>
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
                left: `${timeToX(props.view, Math.min(drawn().t0, drawn().t1))}px`,
                top: `${Math.min(drawn().y0, drawn().y1)}px`,
                width: `${Math.abs(drawn().t1 - drawn().t0) * props.view.pxPerSecond}px`,
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
