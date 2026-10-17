import { createEffect } from "solid-js";

import { fitCanvas } from "~/lib/editor/canvas";
import { type PitchRange, rowCount, type TimeView } from "~/lib/editor/view";
import type { SungPitch } from "~/lib/native/types";

/** A jump bigger than this (semitones) between two frames isn't drawn as a line: it's a new phrase or an octave flip. */
const JUMP = 2.5;

/**
 * A pitch as a line: its height is the pitch, centred on the rows like the notes are. Only the frames in view are
 * drawn; nothing where nothing is sung. What is sung in the vocals (`sung`) goes behind the notes; your voice singing
 * along (`voice`) over them, as it is mostly right on them.
 */
export function PitchTrace(props: {
  pitch: SungPitch;
  kind?: "sung" | "voice";
  view: TimeView;
  width: number;
  height: number;
  range: PitchRange;
}) {
  let canvas: HTMLCanvasElement | undefined;
  /** Its colour, read once (reading it styles the page again). */
  let colour: string | undefined;
  createEffect(
    () => ({
      pitch: props.pitch,
      view: props.view,
      width: props.width,
      height: props.height,
      range: props.range,
    }),
    ({ pitch, view, width, height, range }) => {
      const context = canvas && fitCanvas(canvas, width, height);
      if (!context) return;
      const rowHeight = height / rowCount(range);
      const first = Math.max(0, Math.floor(view.start / pitch.hop) - 1);
      const last = Math.min(pitch.midi.length - 1, Math.ceil((view.start + width / view.pxPerSecond) / pitch.hop) + 1);
      context.strokeStyle = colour ??= getComputedStyle(canvas!).color;
      context.lineWidth = 1.75;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.beginPath();
      let previous: number | null = null;
      for (let i = first; i <= last; i++) {
        const midi = pitch.midi[i];
        if (midi === null || midi === undefined) {
          previous = null;
          continue;
        }
        const x = (i * pitch.hop - view.start) * view.pxPerSecond;
        const y = (range.high - midi) * rowHeight + rowHeight / 2;
        if (previous === null || Math.abs(midi - previous) > JUMP) context.moveTo(x, y);
        else context.lineTo(x, y);
        previous = midi;
      }
      context.stroke();
    },
  );
  return (
    <canvas
      ref={(element) => (canvas = element)}
      class="pointer-events-none absolute inset-0 size-full text-info opacity-80 data-[kind=voice]:z-[5] data-[kind=voice]:text-warning data-[kind=voice]:opacity-100"
      data-kind={props.kind ?? "sung"}
      aria-hidden="true"
      data-testid={props.kind === "voice" ? "voice-trace" : "pitch-trace"}
    />
  );
}
