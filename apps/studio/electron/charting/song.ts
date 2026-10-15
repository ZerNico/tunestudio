/**
 * Whole-song rules after every line has its notes: octave fixes, golden notes, splitting lyric lines the way charters
 * do, line breaks and the final clean-up. A port of the auto-tuner PoC's `chart.fix_octaves`, `mark_golden`,
 * `split_lines`, `line_breaks` and `build_song`.
 */
import { toSec, unit, type Grid } from "./grid";
import type { Note } from "./notes";
import { floorMod, median, median32, pyRound } from "./numpy";
import type { PitchTrack } from "./refiners";

/** The pitch track's frame length in seconds. */
const HOP = 0.01;

/** NumPy's argmin: the index of the first smallest value. */
const firstMin = (values: number[]) => values.reduce((best, v, k) => (v < values[best]! ? k : best), 0);

/** Python's max() with a key: the first of the largest. */
function best<T>(options: T[], score: (o: T) => number): T {
  return options.reduce((top, o) => (score(o) > score(top) ? o : top));
}

/** numpy.searchsorted(sorted, value), left side. */
function searchsorted(sorted: Float64Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The voiced frames between two times, minus the tuning, in float32 like the PoC's. */
function voicedFrames(
  track: PitchTrack,
  a: number,
  b: number,
  tuning: number,
): { voiced: Float32Array; frames: number } {
  const frames = track.midi.subarray(searchsorted(track.times, a), searchsorted(track.times, b));
  const shift = Math.fround(tuning);
  const voiced = Float32Array.from(
    Array.from(frames).filter((m) => !Number.isNaN(m)),
    (m) => Math.fround(m - shift),
  );
  return { voiced, frames: frames.length };
}

/** Python's `len()`: code points. */
const length = (text: string) => [...text].length;

/** For each note: log10(odd / even harmonic energy) for the octave below and for its pitch (native `harmonicRatios`). */
export type HarmonicRatios = ([number, number] | null)[];

export interface OctaveOptions {
  evidence?: number;
  leap?: number;
  stay?: number;
  center?: number;
  harmonic?: number;
}

/**
 * Move notes by whole octaves so the melody doesn't jump around (in place): a Viterbi over a shift of -12/0/+12 per
 * note, song-wide. Costs: `leap` per semitone beyond 7 to the previous note (less across pauses), `stay` for moving a
 * note at all, `center` per semitone beyond 9 from the song's median note, and the vocals' harmonics (`ratios`, one
 * per normal or golden note) telling a note that is really an octave higher or lower. Pitch classes never change.
 */
export function fixOctaves(
  lines: Note[][],
  grid: Grid,
  track: PitchTrack,
  tuning: number,
  ratios: HarmonicRatios | null,
  options: OctaveOptions = {},
): void {
  const { evidence = 0, leap = 0.6, stay = 2, center = 0.3, harmonic = 1 } = options;
  const notes = lines.flat().filter((n) => n.type === "normal" || n.type === "golden");
  if (notes.length < 2) return;
  const shifts = [-12, 0, 12];
  const sung: number[] = [];
  const voicedShare: number[] = [];
  for (const n of notes) {
    const { voiced, frames } = voicedFrames(track, toSec(grid, n.start), toSec(grid, n.start + n.length), tuning);
    sung.push(voiced.length >= 3 ? median32(voiced) : Number.NaN);
    voicedShare.push(voiced.length / Math.max(frames, 1));
  }
  const mid = median(notes.map((n) => n.pitch + 60));
  const useRatios = ratios !== null && harmonic !== 0;

  const own = (i: number, s: number): number => {
    const midi = notes[i]!.pitch + 60;
    let cost = stay * (s !== 0 ? 1 : 0) + center * Math.max(0, Math.abs(midi + s - mid) - 9);
    const ratio = useRatios ? ratios[i] : null;
    if (ratio) {
      // down: odd harmonics of the octave below (high = the sung pitch is that octave), up: of this pitch (low = it's
      // really an octave higher).
      const [down, up] = ratio;
      const hint =
        s === -12
          ? Math.max(0, -1 - down)
          : s === 12
            ? Math.max(0, up + 0.5)
            : Math.max(0, down + 1) + Math.max(0, -0.5 - up);
      cost += harmonic * Math.min(2, hint);
    }
    if (!Number.isNaN(sung[i]!)) cost += evidence * voicedShare[i]! * Math.abs(pyRound((midi + s - sung[i]!) / 12));
    return cost;
  };
  const move = (i: number, s0: number, s1: number): number => {
    const jump = Math.abs(notes[i]!.pitch + 60 + s1 - (notes[i - 1]!.pitch + 60) - s0);
    const previous = notes[i - 1]!;
    const pause = toSec(grid, notes[i]!.start) - toSec(grid, previous.start + previous.length);
    return (leap * Math.max(0, jump - 7)) / (1 + Math.max(pause, 0) / 0.5);
  };

  let cost = shifts.map((s) => own(0, s));
  const back: number[][] = [];
  for (let i = 1; i < notes.length; i++) {
    const step = shifts.map((s1) => shifts.map((s0, a) => cost[a]! + move(i, s0, s1)));
    const best = step.map(firstMin);
    back.push(best);
    cost = step.map((row, k) => row[best[k]!]! + own(i, shifts[k]!));
  }
  let k = firstMin(cost);
  for (let i = notes.length - 1; i >= 0; i--) {
    notes[i]!.pitch += shifts[k]!;
    if (i) k = back[i - 1]![k]!;
  }
}

/**
 * Golden notes (double points), as charters pick them: the `share` of notes with the most steadily sung time on the
 * charted pitch (at least `minSec`), spread out so no tenth of the song gets more than a quarter of them (in place).
 */
export function markGolden(
  lines: Note[][],
  grid: Grid,
  track: PitchTrack,
  tuning: number,
  share = 0.05,
  minSec = 0.4,
): void {
  const notes = lines.flat().filter((n) => n.type === "normal");
  let want = pyRound(share * notes.length);
  if (want === 0) return;
  const scored: [number, Note][] = [];
  for (const n of notes) {
    const a = toSec(grid, n.start);
    const b = toSec(grid, n.start + n.length);
    if (b - a < minSec) continue;
    const { voiced } = voicedFrames(track, a, b, tuning);
    const midi = n.pitch + 60;
    let onPitch = 0;
    for (const f of voiced) {
      const d = Math.fround(floorMod(Math.abs(Math.fround(f - midi)), 12));
      if (Math.min(d, Math.fround(12 - d)) <= 0.5) onPitch++;
    }
    scored.push([onPitch * HOP, n]);
  }
  const first = notes[0]!.start;
  const last = notes.at(-1)!.start + notes.at(-1)!.length;
  const perTenth = new Map<number, number>();
  const cap = Math.max(1, Math.floor(want / 4));
  for (const [onPitch, n] of scored.toSorted((x, y) => y[0] - x[0])) {
    if (want === 0 || onPitch < minSec * 0.6) break;
    const tenth = Math.min(9, Math.trunc((10 * (n.start - first)) / Math.max(last - first, 1)));
    if ((perTenth.get(tenth) ?? 0) >= cap) continue;
    perTenth.set(tenth, (perTenth.get(tenth) ?? 0) + 1);
    n.type = "golden";
    want--;
  }
}

/** The lyrics of notes: their texts without "~" continuations, trimmed. */
function lyricText(notes: readonly Note[]): string {
  return notes
    .filter((n) => n.text.trim() !== "~")
    .map((n) => n.text)
    .join("")
    .trim();
}

const wordCount = (text: string) => text.split(/\s+/u).filter((w) => w).length;

/**
 * Break lyric lines (LRCLIB's, often two sung phrases long) the way charters do: at nearly every pause of `pause` s
 * or more between words, and lines over `maxChars` characters or `maxSec` seconds at their best word gap (long
 * pause, punctuation, balanced halves). Never inside a word, never leaving a one-word line.
 */
export function splitLines(lines: Note[][], grid: Grid, maxChars = 40, maxSec = 6, pause = 0.6): Note[][] {
  const u = unit(grid);
  const cuts = (line: Note[]): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1]!, line[i]!];
      if (!a.text.endsWith(" ") || ["~", ""].includes(b.text.trim())) continue;
      if (wordCount(lyricText(line.slice(0, i))) < 2 || wordCount(lyricText(line.slice(i))) < 2) continue;
      out.push([i, (b.start - a.start - a.length) * u]);
    }
    return out;
  };
  const split = (line: Note[]): Note[][] => {
    const options = cuts(line);
    if (!options.length) return [line];
    let [i, gap] = best(options, (c) => c[1]);
    const end = line.at(-1)!.start + line.at(-1)!.length;
    const tooLong = length(lyricText(line)) > maxChars || (end - line[0]!.start) * u > maxSec;
    if (gap < pause && !tooLong) return [line];
    if (gap < pause) {
      // Too long without a clear pause: weigh punctuation and balance too.
      const total = length(lyricText(line));
      const score = (c: [number, number]) => {
        const left = lyricText(line.slice(0, c[0]));
        const lastChar = [...left].at(-1) ?? "";
        return c[1] + (",.;:!?".includes(lastChar) ? 0.3 : 0) - (0.5 * Math.abs(2 * length(left) - total)) / total;
      };
      [i, gap] = best(options, score);
    }
    return [...split(line.slice(0, i)), ...split(line.slice(i))];
  };
  return lines.filter((line) => line.length).flatMap(split);
}

/**
 * The beat each line switches to the next at: USDX shows the next line when its break beat is reached, so charters
 * break soon after a line ends (`share` of the pause, at most `most` seconds), always before the next line starts.
 */
export function lineBreaks(lines: readonly Note[][], grid: Grid, share = 0.4, most = 2): number[] {
  const u = unit(grid);
  return lines.slice(1).map((line, k) => {
    const end = Math.max(...lines[k]!.map((n) => n.start + n.length));
    const next = line[0]!.start;
    const pause = (next - end) * u;
    const beat = end + pyRound(Math.min(share * pause, most) / u);
    return Math.min(Math.max(beat, end), next);
  });
}

/** Python's `f"{x:.3f}"`: exact decimal rounding, ties to even (JavaScript's toFixed rounds ties up). */
export function fixed3(x: number): string {
  const s = x.toFixed(3);
  // A tie needs x·1000 to end in exactly .5, which only dyadic fractions can: check exactly with the double's bits.
  const scaled = x * 1000;
  if (Math.abs(scaled) >= 2 ** 52 || scaled - Math.floor(scaled) !== 0.5 || scaled / 1000 !== x) return s;
  const floor = Math.floor(scaled);
  const even = floor % 2 === 0 ? floor : floor + 1;
  return (even / 1000).toFixed(3);
}

/** The #BPM header as the PoC writes it: three decimals without trailing zeros. */
export function bpmHeader(bpm: number): string {
  return fixed3(bpm).replace(/0+$/, "").replace(/\.$/, "");
}

/** The #GAP header in milliseconds. */
export function gapHeader(gap: number): number {
  return pyRound(gap * 1000);
}

/**
 * The final clean-up of the chart's lines (in place, notes sorted by start), returning the line breaks: "~" notes that
 * just continue the previous note are merged into it, starts made strictly increasing and notes non-overlapping, and
 * notes under 0.1 s lengthened into free time.
 */
export function finishLines(lines: Note[][], grid: Grid): { lines: Note[][]; breaks: number[] } {
  const u = unit(grid);
  const sorted = lines.filter((line) => line.length).map((line) => line.toSorted((a, b) => a.start - b.start));
  // A "~" on the same pitch right after its note is one held note; so is a short "~" (<= 0.12 s) up to 3 semitones
  // away: charters keep singing the previous note there.
  const tail = 0.12 / u;
  const merged = sorted.map((line) => {
    const kept: Note[] = [];
    for (const n of line) {
      const p = kept.at(-1);
      if (
        p &&
        n.text.trim() === "~" &&
        n.type === p.type &&
        n.start - (p.start + p.length) <= 1 &&
        (n.pitch === p.pitch || (Math.abs(n.pitch - p.pitch) <= 3 && n.length <= tail))
      ) {
        if (n.length > p.length) p.pitch = n.pitch;
        p.length = n.start + n.length - p.start;
        if (n.text.endsWith(" ") && !p.text.endsWith(" ")) p.text += " ";
        continue;
      }
      kept.push(n);
    }
    return kept;
  });
  const notes = merged.flat();
  for (let i = 0; i + 1 < notes.length; i++) {
    const [a, b] = [notes[i]!, notes[i + 1]!];
    if (b.start <= a.start) {
      const end = b.start + b.length;
      b.start = a.start + 1;
      b.length = Math.max(1, end - b.start);
    }
  }
  for (let i = 0; i + 1 < notes.length; i++) {
    const [a, b] = [notes[i]!, notes[i + 1]!];
    if (a.start + a.length > b.start) a.length = Math.max(1, b.start - a.start - 1);
  }
  // Notes under 0.1 s are hard to hit: lengthen them into free time, keeping one unit before the next note.
  const least = Math.ceil(0.1 / u);
  notes.forEach((a, i) => {
    const b = notes[i + 1];
    if (a.length < least) a.length = Math.max(a.length, b ? Math.min(least, b.start - a.start - 1) : least);
  });
  return { lines: merged, breaks: lineBreaks(merged, grid) };
}
