import { createEffect } from "solid-js";

import { type PitchRange, rowCount, type TimeView } from "~/lib/editor/view";
import type { SungPitch } from "~/lib/native/types";

/** A jump bigger than this (semitones) between two frames isn't drawn as a line: it's a new phrase or an octave flip. */
const JUMP = 2.5;

/**
 * What is sung, as a line behind the notes: its height is the pitch, centred on the rows like the notes are. Only the
 * frames in view are drawn; nothing where nothing is sung.
 */
export function PitchTrace(props: {
  pitch: SungPitch;
  view: TimeView;
  width: number;
  height: number;
  range: PitchRange;
}) {
  let canvas: HTMLCanvasElement | undefined;
  createEffect(
    () => ({
      pitch: props.pitch,
      view: props.view,
      width: props.width,
      height: props.height,
      range: props.range,
    }),
    ({ pitch, view, width, height, range }) => {
      const context = canvas?.getContext("2d");
      if (!canvas || !context || width <= 0 || height <= 0) return;
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.clearRect(0, 0, width, height);
      const rowHeight = height / rowCount(range);
      const first = Math.max(0, Math.floor(view.start / pitch.hop) - 1);
      const last = Math.min(pitch.midi.length - 1, Math.ceil((view.start + width / view.pxPerSecond) / pitch.hop) + 1);
      context.strokeStyle = getComputedStyle(canvas).color;
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
      class="pointer-events-none absolute inset-0 size-full text-info opacity-80"
      aria-hidden="true"
      data-testid="pitch-trace"
    />
  );
}
