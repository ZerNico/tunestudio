/**
 * The editor's view of the song: which stretch of time is on screen and how wide a second is, and the pitch rows.
 * Pure functions; the editor keeps one `TimeView` and replaces it on zoom and scroll.
 */

/** A stretch of the song on screen: `start` seconds at the left edge, `pxPerSecond` wide per second. */
export interface TimeView {
  start: number;
  pxPerSecond: number;
}

/** From a whole song on a small window to single grid steps. */
export const MIN_PX_PER_SECOND = 4;
export const MAX_PX_PER_SECOND = 1200;

export function timeToX(view: TimeView, time: number): number {
  return (time - view.start) * view.pxPerSecond;
}

export function xToTime(view: TimeView, x: number): number {
  return view.start + x / view.pxPerSecond;
}

/** The seconds on screen in a `width` px wide area. */
export function visibleSeconds(view: TimeView, width: number): number {
  return width / view.pxPerSecond;
}

/** The furthest out the view zooms: the whole song (`length` seconds) across the area, and no further. */
function minPxPerSecond(width: number, length: number): number {
  return length > 0 && width > 0 ? Math.max(MIN_PX_PER_SECOND, width / length) : MIN_PX_PER_SECOND;
}

/**
 * The view kept on the song (`length` seconds): zoomed out no further than the whole song, and no scrolling before 0
 * or past the end.
 */
export function clampView(view: TimeView, width: number, length: number): TimeView {
  const pxPerSecond = Math.min(MAX_PX_PER_SECOND, Math.max(minPxPerSecond(width, length), view.pxPerSecond));
  const latest = Math.max(0, length - width / pxPerSecond);
  return { pxPerSecond, start: Math.min(latest, Math.max(0, view.start)) };
}

/** Zooms by `factor` (above 1: in) keeping the time under `x` where it is. */
export function zoomAt(view: TimeView, factor: number, x: number, width: number, length: number): TimeView {
  const time = xToTime(view, x);
  const pxPerSecond = Math.min(MAX_PX_PER_SECOND, Math.max(minPxPerSecond(width, length), view.pxPerSecond * factor));
  return clampView({ pxPerSecond, start: time - x / pxPerSecond }, width, length);
}

/** Scrolls by `dx` pixels (positive: later in the song). */
export function scrollBy(view: TimeView, dx: number, width: number, length: number): TimeView {
  return clampView({ ...view, start: view.start + dx / view.pxPerSecond }, width, length);
}

/** A view showing `from`..`to` with a little room on both sides. */
export function fitRange(from: number, to: number, width: number, length: number, margin = 0.08): TimeView {
  const span = Math.max(0.5, to - from);
  const pxPerSecond = width / (span * (1 + 2 * margin));
  return clampView({ pxPerSecond, start: from - span * margin }, width, length);
}

/**
 * The view with `start`..`end` on screen: as it is when it is already, else scrolled so the span starts `lead` (a share
 * of the screen) from the left.
 */
export function revealSpan(
  view: TimeView,
  span: { start: number; end: number },
  width: number,
  length: number,
  lead: number,
): TimeView {
  const seconds = visibleSeconds(view, width);
  if (span.start >= view.start && span.end <= view.start + seconds) return view;
  return clampView({ ...view, start: span.start - seconds * lead }, width, length);
}

/** Whether `time` is on the page following leaves alone: on screen, short of the right edge where it turns the page. */
export function onPage(view: TimeView, time: number, width: number): boolean {
  return time >= view.start && time < view.start + visibleSeconds(view, width) * 0.92;
}

/** Scrolls just enough to bring `time` back on screen, a page at a time (playback following the playhead). */
export function follow(view: TimeView, time: number, width: number, length: number): TimeView {
  if (onPage(view, time, width)) return view;
  return clampView({ ...view, start: time - visibleSeconds(view, width) * 0.05 }, width, length);
}

/** Ruler steps in seconds, from fine to coarse. */
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];

/** The ruler step: the finest one whose labels are at least `minPx` apart. */
export function rulerStep(pxPerSecond: number, minPx = 72): number {
  return STEPS.find((step) => step * pxPerSecond >= minPx) ?? STEPS.at(-1)!;
}

/** The ruler's marks on screen. */
export function rulerTicks(view: TimeView, width: number, minPx?: number): number[] {
  const step = rulerStep(view.pxPerSecond, minPx);
  const end = view.start + visibleSeconds(view, width);
  const ticks: number[] = [];
  // Whole multiples of the step, counted so float error doesn't drift (0.1 + 0.2 …).
  for (let i = Math.ceil(view.start / step - 1e-9); i * step <= end; i++)
    ticks.push(Math.round(i * step * 1000) / 1000);
  return ticks;
}

/** "1:07.4" (tenths, cut off, not rounded), or "1:07" without them. */
export function formatTime(seconds: number, tenths = true): string {
  const sign = seconds < 0 ? "-" : "";
  const total = Math.abs(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  const secs = tenths ? (Math.floor(rest * 10) / 10).toFixed(1) : String(Math.floor(rest));
  return `${sign}${minutes}:${secs.padStart(tenths ? 4 : 2, "0")}`;
}

/** The pitches drawn, lowest to highest (MIDI). */
export interface PitchRange {
  low: number;
  high: number;
}

/**
 * Room above and below the chart's notes (a row: notes don't touch the edges, and changing the highest or lowest note
 * moves the rows little), and the fewest rows shown.
 */
const PITCH_MARGIN = 1;
const MIN_ROWS = 18;

/** The rows for a chart: its lowest to highest note with some room, at least an octave and a half. */
export function pitchRange(pitches: Iterable<number>): PitchRange {
  let low = Infinity;
  let high = -Infinity;
  for (const pitch of pitches) {
    low = Math.min(low, pitch);
    high = Math.max(high, pitch);
  }
  if (low > high) return { low: 60 - MIN_ROWS / 2, high: 60 + MIN_ROWS / 2 - 1 };
  low -= PITCH_MARGIN;
  high += PITCH_MARGIN;
  const missing = MIN_ROWS - (high - low + 1);
  if (missing > 0) {
    low -= Math.floor(missing / 2);
    high += Math.ceil(missing / 2);
  }
  return { low, high };
}

export function rowCount(range: PitchRange): number {
  return range.high - range.low + 1;
}

/** The top of `pitch`'s row, with the highest pitch at the top. */
export function pitchToY(range: PitchRange, rowHeight: number, pitch: number): number {
  return (range.high - pitch) * rowHeight;
}

/** The pitch whose row is at `y`. */
export function yToPitch(range: PitchRange, rowHeight: number, y: number): number {
  return range.high - Math.floor(y / rowHeight);
}

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

/** "E4" for 64 (MIDI, C4 = 60). */
export function pitchName(pitch: number): string {
  return `${NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

/** Something with a start and length in seconds. */
interface Span {
  start: number;
  duration: number;
}

/**
 * The items (sorted by start) that overlap `from`..`to`: a binary search for the first that may reach `from`, given
 * the longest item, then a scan to `to`. Only these are drawn.
 */
export function visibleItems<T extends Span>(sorted: readonly T[], from: number, to: number, longest: number): T[] {
  let lo = 0;
  let hi = sorted.length;
  const earliest = from - longest;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.start < earliest) lo = mid + 1;
    else hi = mid;
  }
  const out: T[] = [];
  for (let i = lo; i < sorted.length && sorted[i]!.start < to; i++) {
    const item = sorted[i]!;
    if (item.start + item.duration > from) out.push(item);
  }
  return out;
}
