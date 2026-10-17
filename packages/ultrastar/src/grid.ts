export interface ChartGrid {
  bpm: number;
  /** Milliseconds, matching the UltraStar GAP header. */
  gap: number;
}

/** Strict decimal parsing: accepts decimal comma, not partial numbers or exponents. */
export function parseDecimal(value: string | undefined, name = "Number"): number {
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value.trim())) {
    throw new RangeError(`${name} must be a finite decimal number (received ${JSON.stringify(value)}).`);
  }
  const result = Number(value.trim().replace(",", "."));
  if (!Number.isFinite(result)) throw new RangeError(`${name} must be finite.`);
  return result;
}

export function gridFromMetadata(metadata: Record<string, string>): ChartGrid {
  const bpm = parseDecimal(metadata.BPM, "BPM");
  // An empty `#GAP:` is no GAP, as the v1 format says of every empty header.
  const gap = metadata.GAP?.trim() ? parseDecimal(metadata.GAP, "GAP") : 0;
  const grid = { bpm, gap };
  assertGrid(grid);
  return grid;
}

function assertGrid(grid: ChartGrid): void {
  if (!Number.isFinite(grid.bpm) || grid.bpm <= 0 || !Number.isFinite(15 / grid.bpm) || 15 / grid.bpm <= 0) {
    throw new RangeError("BPM must be finite and greater than zero.");
  }
  if (!Number.isFinite(grid.gap)) throw new RangeError("GAP must be finite milliseconds.");
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite.`);
}

/** One file tick is 1/4 of a musical beat: 60 / (BPM * 4) seconds. */
export function tickDuration(bpm: number): number {
  assertGrid({ bpm, gap: 0 });
  return 15 / bpm;
}

export function ticksToSeconds(ticks: number, grid: ChartGrid): number {
  assertGrid(grid);
  finite(ticks, "Ticks");
  const seconds = grid.gap / 1000 + ticks * (15 / grid.bpm);
  finite(seconds, "Converted seconds");
  return seconds;
}

export function secondsToTicks(seconds: number, grid: ChartGrid): number {
  assertGrid(grid);
  finite(seconds, "Seconds");
  const ticks = (seconds - grid.gap / 1000) / (15 / grid.bpm);
  finite(ticks, "Converted ticks");
  return ticks;
}

export interface QuantizedTiming {
  start: number;
  duration: number;
}

/** Round both edges; retain at least one tick for sub-grid notes. Does not mutate. */
export function quantizeNoteTiming(start: number, duration: number, grid: ChartGrid): QuantizedTiming {
  if (!Number.isFinite(duration) || duration <= 0) throw new RangeError("Duration must be positive and finite.");
  const startTick = Math.round(secondsToTicks(start, grid));
  const endTick = Math.round(secondsToTicks(start + duration, grid));
  const length = Math.max(1, endTick - startTick);
  if (![startTick, endTick, length, startTick + length].every(Number.isSafeInteger)) {
    throw new RangeError("Note timing exceeds the safe integer range of the UltraStar grid.");
  }
  return { start: Object.is(startTick, -0) ? 0 : startTick, duration: length };
}

/**
 * When the next line appears if the chart doesn't say, by the rule YASS, Karedi and UltraStar Deluxe's editor share
 * (the one ultrastar-es.org expects), so a chart reads the same in all of them. In a gap of 4 s or more, 2 s after the
 * last note; of 2 s or more, 1 s after. Shorter ones go by grid steps (`step`, the file's beats): under 2 at the last
 * note's end, up to 8 two before the next note, up to 12 three before, up to 16 four before, else ten after the end.
 */
export function defaultSwitch(gapStart: number, gapEnd: number, step: number): number {
  const seconds = gapEnd - gapStart;
  if (seconds >= 4) return gapStart + 2;
  if (seconds >= 2) return gapStart + 1;
  const steps = Math.round(seconds / step);
  if (steps < 2) return gapStart;
  if (steps <= 8) return gapEnd - 2 * step;
  if (steps <= 12) return gapEnd - 3 * step;
  if (steps <= 16) return gapEnd - 4 * step;
  return gapStart + 10 * step;
}
