/**
 * The waveform lane's shape: for every pixel column on screen, the loudest of the waveform's values it covers, scaled
 * so the song's loud parts (`loudest`) are the lane's full height. `WaveformLane` draws them mirrored around its middle.
 */
import type { Waveform } from "~/lib/native/types";

import type { TimeView } from "./view";

/**
 * What fills the lane: louder than 98% of the song's values (a few loud moments would leave the rest small, so they are
 * cut off instead), and at least a little, so silence stays flat.
 */
export function loudest(waveform: Waveform): number {
  // The values have three decimals: counting each finds the 98th percentile without sorting a long song's values.
  const counts = new Uint32Array(1001);
  for (const value of waveform.levels) counts[Math.min(1000, Math.max(0, Math.round(value * 1000)))]!++;
  const rank = Math.floor((waveform.levels.length - 1) * 0.98);
  let seen = 0;
  for (let step = 0; step <= 1000; step++) {
    seen += counts[step]!;
    if (seen > rank) return Math.max(0.05, step / 1000);
  }
  return 0.05;
}

/** Each pixel column's height (0-1) across `width` px of the view; columns past the waveform are 0. */
export function waveColumns(waveform: Waveform, view: TimeView, width: number, scale = loudest(waveform)): number[] {
  const columns: number[] = [];
  const count = waveform.levels.length;
  for (let x = 0; x < Math.ceil(width); x++) {
    const from = Math.max(0, Math.floor((view.start + x / view.pxPerSecond) / waveform.hop));
    // At least one value per column, however far zoomed in.
    const to = Math.min(count, Math.max(from + 1, Math.ceil((view.start + (x + 1) / view.pxPerSecond) / waveform.hop)));
    let level = 0;
    for (let i = from; i < to; i++) level = Math.max(level, waveform.levels[i]!);
    columns.push(Math.min(1, level / scale));
  }
  return columns;
}
