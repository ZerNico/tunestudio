/**
 * The alignment stage: lyrics aligned to the vocals, line by line. The whole song is aligned at once; when the lyrics
 * have line times (LRCLIB), they are a sanity check: their offset to this recording is estimated from the lines the
 * aligner is confident about, and only lines that start far from where the lyrics say (or score very low) are
 * re-aligned inside their window. A port of the auto-tuner PoC's `pipeline._align_stage`, `_windowed` and
 * `align.align`.
 */
import {
  isWord,
  joinParts,
  pullInEdges,
  snapToVoice,
  timingsFromPath,
  wordParts,
  alignerTargets,
  type WordTiming,
} from "./align";
import { splitWords } from "./aligner-text";
import { mean, median } from "./numpy";

/** The aligner's output stride: one frame per 20 ms. */
export const STRIDE_MS = 20;
const FRAME = STRIDE_MS / 1000;
/** The pitch track's frame length in seconds. */
const HOP = 0.01;

/** A lyric line: its text and, when the lyrics are line-synced, where it roughly starts and ends. */
export interface LyricLine {
  text: string;
  start: number | null;
  end: number | null;
  /** The line's start in other timings of the same lyrics; the stage uses whichever fits the recording best. */
  altStarts?: number[];
}

/** Words to align inside a window of the song (null: from the start / to the end). */
export interface AlignRequest {
  words: string[];
  start: number | null;
  end: number | null;
}

/** The text can't be aligned in the given frames (e.g. more letters than frames). */
export class AlignFailed extends Error {}

/**
 * The CTC path through frames [from, to) of the song's emissions for the target ids (native Viterbi), with the
 * per-frame scores. Throws AlignFailed when the text can't fit.
 */
export type ForcedAlign = (
  from: number,
  to: number,
  ids: Int32Array,
) => Promise<{ path: ArrayLike<number>; scores: Float32Array }>;

/** Align each request inside its window, one timing per singable word (`align.align` with no padding). */
export async function alignRequests(
  requests: readonly AlignRequest[],
  language: string,
  frames: number,
  forcedAlign: ForcedAlign,
): Promise<WordTiming[][]> {
  const out: WordTiming[][] = [];
  for (const request of requests) {
    const words = request.words.filter((w) => isWord(w));
    if (!words.length) {
      out.push([]);
      continue;
    }
    const lo = request.start === null ? 0 : Math.max(0, Math.trunc(request.start / FRAME));
    const hi = request.end === null ? frames : Math.min(frames, Math.trunc(request.end / FRAME) + 1);
    const parts = words.map((w) => wordParts(w));
    const flatWords = parts.flat();
    const { path, scores } = await forcedAlign(lo, hi, alignerTargets(flatWords, language).ids);
    const flat = timingsFromPath(path, scores, flatWords, language, STRIDE_MS, lo * FRAME);
    out.push(joinParts(words, parts, flat));
  }
  return out;
}

/** How the line times were used, for the log. */
export interface LineTimingFit {
  offset: number;
  spread: number;
  ignored?: boolean;
  linesUsed?: number;
  timing?: number;
  realigned?: number[];
}

export interface AlignStageInput {
  lines: readonly LyricLine[];
  language: string;
  /** Number of emission frames (the song's length in 20 ms). */
  frames: number;
  forcedAlign: ForcedAlign;
  /** The float32 pitch track: MIDI per 10 ms frame (NaN unvoiced) and loudness in dB. */
  midi: Float32Array;
  rms: Float32Array;
  /** Seconds of the pitch track's last frame. */
  songEnd: number;
  maxOff?: number;
  minScore?: number;
  pad?: number;
}

/** One request's alignment, computed once per distinct request (the PoC caches them the same way). */
function cached(input: AlignStageInput) {
  const memo = new Map<string, WordTiming[]>();
  return async (request: AlignRequest): Promise<WordTiming[]> => {
    const key = JSON.stringify(request);
    let found = memo.get(key);
    if (!found) {
      found = (await alignRequests([request], input.language, input.frames, input.forcedAlign))[0]!;
      memo.set(key, found);
    }
    // Callers change timings in place: hand out copies.
    return structuredClone(found);
  };
}

function split<T>(flat: T[], sizes: number[]): T[][] {
  let at = 0;
  return sizes.map((size) => flat.slice(at, (at += size)));
}

/** Word timings for each lyric line ([] for a line without singable words), and how line times were used. */
export async function alignStage(
  input: AlignStageInput,
): Promise<{ aligned: WordTiming[][]; fit: LineTimingFit | null }> {
  const { maxOff = 1.0, minScore = -3.0, pad = 1.0 } = input;
  let lines = input.lines.map((line) => ({ ...line }));
  const align = cached(input);
  const words = lines.map((line) => splitWords(line.text));
  const sizes = words.map((ws) => ws.filter((w) => isWord(w)).length);
  let timed = lines.every((line) => line.start !== null);
  let aligned: WordTiming[][];
  try {
    aligned = split(await align({ words: words.flat(), start: null, end: null }), sizes);
  } catch (error) {
    // With line times, align line by line in their windows instead.
    if (!(error instanceof AlignFailed) || !timed) throw error;
    return { aligned: await windowed(input, lines, words, align, pad), fit: null };
  }
  let fit: LineTimingFit | null = null;
  let offset = 0;
  if (timed) {
    // Offset and spread of each timing against the lines the aligner is confident about; keep the best fit.
    const confident = aligned.flatMap((ws, i) => (ws.length && mean(ws.map((w) => w.score)) > -2 ? [i] : []));
    const alternatives = Math.min(...lines.map((line) => line.altStarts?.length ?? 0));
    const timings = [
      lines.map((line) => line.start!),
      ...Array.from({ length: alternatives }, (_, k) => lines.map((line) => line.altStarts![k]!)),
    ];
    let best: { spread: number; offset: number; starts: number[]; used: number; index: number } | null = null;
    timings.forEach((starts, index) => {
      const diffs = confident.filter((i) => Number.isFinite(starts[i]!)).map((i) => aligned[i]![0]!.start - starts[i]!);
      const off = diffs.length ? median(diffs) : 0;
      // Too few matched lines can't vouch for a timing.
      const ok = diffs.length >= Math.max(5, 0.3 * confident.length);
      const spread = ok ? median(diffs.map((d) => Math.abs(d - off))) : Infinity;
      if (!best || spread < best.spread) best = { spread, offset: off, starts, used: diffs.length, index };
    });
    const chosen = best!;
    offset = chosen.offset;
    lines = lines.map((line, i) => ({ text: line.text, start: chosen.starts[i]!, end: line.end }));
    fit = { offset, spread: chosen.spread };
    // Large offsets are fine (music videos often have a long intro); an inconsistent timing is not: then the line
    // times are for another version of the song and would only mislead.
    if (chosen.spread > 1.0 || Math.abs(offset) > 120) {
      fit.ignored = true;
      timed = false;
    } else {
      const starts = lines.map((line) => line.start! + offset);
      const realigned: number[] = [];
      for (const [i, ws] of aligned.entries()) {
        if (!ws.length || !Number.isFinite(starts[i]!)) continue; // NaN: line not in the chosen timing's version
        if (Math.abs(ws[0]!.start - starts[i]!) <= maxOff && mean(ws.map((w) => w.score)) >= minScore) continue;
        const end = starts.slice(i + 1).find((s) => Number.isFinite(s)) ?? input.songEnd;
        if (end <= starts[i]!) continue; // line times out of order
        try {
          aligned[i] = await align({ words: words[i]!, start: Math.max(0, starts[i]! - pad), end: end + pad });
          realigned.push(i);
        } catch (error) {
          if (!(error instanceof AlignFailed)) throw error;
          // Window too short for the text: keep the whole-song result.
        }
      }
      Object.assign(fit, { linesUsed: chosen.used, timing: chosen.index, realigned });
    }
  }
  for (const line of aligned) {
    pullInEdges(line);
    snapToVoice(line, input.midi, input.rms, HOP);
  }
  return { aligned, fit };
}

async function windowed(
  input: AlignStageInput,
  lines: readonly LyricLine[],
  words: string[][],
  align: (r: AlignRequest) => Promise<WordTiming[]>,
  pad: number,
): Promise<WordTiming[][]> {
  const out: WordTiming[][] = [];
  for (const [i, line] of lines.entries()) {
    const end = i + 1 < lines.length ? lines[i + 1]!.start! : input.songEnd;
    try {
      out.push(await align({ words: words[i]!, start: Math.max(0, line.start! - pad), end: end + pad }));
    } catch (error) {
      if (!(error instanceof AlignFailed)) throw error;
      out.push([]);
    }
  }
  for (const line of out) {
    pullInEdges(line);
    snapToVoice(line, input.midi, input.rms, HOP);
  }
  return out;
}
