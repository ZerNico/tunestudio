import { For } from "solid-js";

import type { DrawnNote, LineBreak } from "~/lib/editor/chart";
import { type PitchRange, pitchName, pitchToY, rowCount, timeToX, type TimeView } from "~/lib/editor/view";

/** Notes narrower than this show no syllable (it would only be a clipped letter). */
const MIN_LABEL_PX = 18;

/** How wide the pitch labels at the roll's left are; the other lanes leave the same room. */
export const GUTTER_PX = 40;

/**
 * The notes on screen against time and pitch: rows per semitone (C rows a little lighter, labelled every C and E),
 * each note a bar with its syllable, line breaks dashed at their switch times (fainter when the chart doesn't store
 * one). Only what is in view is given; the playhead is drawn over all lanes (`Playhead`).
 */
export function PianoRoll(props: {
  notes: DrawnNote[];
  breaks: LineBreak[];
  range: PitchRange;
  view: TimeView;
  /** The drawing area (without the gutter). */
  width: number;
  height: number;
  /** Duets draw singer 2 in violet. */
  onSeek: (seconds: number) => void;
}) {
  const rowHeight = () => props.height / rowCount(props.range);
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
          const rect = event.currentTarget.getBoundingClientRect();
          props.onSeek(props.view.start + (event.clientX - rect.left) / props.view.pxPerSecond);
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
          {(note) => (
            <div
              data-singer={note.singer}
              data-type={note.type}
              title={`${note.lyric.trim() || "–"} · ${pitchName(note.pitch)}`}
              class="pointer-events-none absolute truncate rounded-[3px] border border-primary-line bg-primary-soft px-1 text-[10px] leading-none text-primary-text data-[singer=2]:border-violet-line data-[singer=2]:bg-violet-soft data-[singer=2]:text-violet-text data-[type=freestyle]:border-dashed data-[type=freestyle]:bg-transparent data-[type=golden]:border-amber-33 data-[type=golden]:bg-warning-soft data-[type=golden]:text-amber-73 data-[type=golden-rap]:border-amber-33 data-[type=golden-rap]:bg-warning-soft data-[type=golden-rap]:text-amber-73 data-[type=golden-rap]:italic data-[type=rap]:italic"
              style={{
                left: `${timeToX(props.view, note.start)}px`,
                width: `${Math.max(2, note.duration * props.view.pxPerSecond - 1)}px`,
                top: `${pitchToY(props.range, rowHeight(), note.pitch) + 1}px`,
                height: `${Math.max(4, rowHeight() - 2)}px`,
                "line-height": `${Math.max(4, rowHeight() - 2)}px`,
              }}
              data-testid="roll-note"
            >
              {/* Too narrow for a readable syllable: the title still names it. */}
              {note.duration * props.view.pxPerSecond >= MIN_LABEL_PX ? note.lyric : ""}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
