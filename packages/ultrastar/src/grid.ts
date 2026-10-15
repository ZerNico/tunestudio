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
  const gap = metadata.GAP === undefined ? 0 : parseDecimal(metadata.GAP, "GAP");
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

/** Snap around GAP, not audio zero. stepTicks=4 is one musical beat. */
export function snapToGrid(seconds: number, grid: ChartGrid, stepTicks = 1): number {
  if (!Number.isFinite(stepTicks) || stepTicks <= 0) throw new RangeError("Grid step must be positive.");
  return ticksToSeconds(Math.round(secondsToTicks(seconds, grid) / stepTicks) * stepTicks, grid);
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

export function midiToPitchName(midi: number): string {
  if (!Number.isSafeInteger(midi)) throw new RangeError("MIDI pitch must be an integer.");
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
