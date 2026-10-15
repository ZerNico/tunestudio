/**
 * From the aligner's CTC path to word timings: ctc-forced-aligner's `merge_repeats` and `get_spans` and the auto-tuner
 * PoC's `align._align_tokens` / `align.align`, plus its clean-ups `pull_in_edges` and `snap_to_voice`. The path
 * itself (Viterbi over the emissions) comes from the native addon.
 */
import { alignerTokens, splitWords } from "./aligner-text";
import { mean, mean32, percentile32, pyRound } from "./numpy";

/** The aligner's vocabulary (the pinned model's vocab.json, lowercased) plus "<star>" after it. */
export const VOCAB: Record<string, number> = {
  "<blank>": 0,
  "<pad>": 1,
  "</s>": 2,
  "<unk>": 3,
  a: 4,
  i: 5,
  e: 6,
  n: 7,
  o: 8,
  u: 9,
  t: 10,
  s: 11,
  r: 12,
  m: 13,
  k: 14,
  l: 15,
  d: 16,
  g: 17,
  h: 18,
  y: 19,
  b: 20,
  p: 21,
  w: 22,
  c: 23,
  v: 24,
  j: 25,
  z: 26,
  f: 27,
  "'": 28,
  q: 29,
  x: 30,
  "<star>": 31,
};
export const BLANK = VOCAB["<blank>"]!;
const LABELS = Object.fromEntries(Object.entries(VOCAB).map(([label, id]) => [id, label]));

export interface WordTiming {
  text: string;
  start: number;
  end: number;
  /** Mean log-probability; closer to 0 is more confident. */
  score: number;
  /** [start, end] of each romanized character, in seconds. */
  chars: [number, number][];
}

interface Segment {
  label: string;
  start: number;
  end: number;
}

/** Python's `\w` (letters, numbers, `_`): whether a lyric word has anything to sing. */
export function isWord(text: string): boolean {
  return /[\p{L}\p{N}_]/u.test(text);
}

/** What the aligner sees of one lyric word: no `~`, and "oh–oh–oh" split so one token can't swallow seconds. */
export function wordParts(word: string): string[] {
  return word
    .replaceAll("~", "")
    .split(/[-\u2013\u2014]+/u)
    .filter((part) => isWord(part));
}

/** The aligner's targets for a list of words: "<star>" before each word's letters, as preprocess_text makes them. */
export function alignerTargets(words: readonly string[], language: string): { tokens: string[]; ids: Int32Array } {
  const tokens = alignerTokens(words.join(" "), language).flatMap((token) => ["<star>", token]);
  const ids = tokens.flatMap((token) =>
    token === "<star>" ? [VOCAB["<star>"]!] : token.split(" ").flatMap((c) => (c in VOCAB ? [VOCAB[c]!] : [])),
  );
  return { tokens, ids: Int32Array.from(ids) };
}

/** Runs of the same label in a frame path. */
export function mergeRepeats(path: ArrayLike<number>): Segment[] {
  const segments: Segment[] = [];
  let i1 = 0;
  while (i1 < path.length) {
    let i2 = i1;
    while (i2 < path.length && path[i1] === path[i2]) i2++;
    segments.push({ label: LABELS[path[i1]!]!, start: i1, end: i2 - 1 });
    i1 = i2;
  }
  return segments;
}

/** ctc-forced-aligner's `get_spans`: each token's segments, padded with half of the blanks around it. */
export function getSpans(tokens: readonly string[], segments: readonly Segment[]): Segment[][] {
  const blank = LABELS[BLANK]!;
  const intervals: [number, number][] = [];
  let letter = 0;
  let token = 0;
  let start = 0;
  for (const [index, segment] of segments.entries()) {
    if (token === tokens.length) {
      if (index !== segments.length - 1 || segment.label !== blank)
        throw new Error("The alignment has segments after its last token.");
      continue;
    }
    const letters = tokens[token]!.split(" ");
    if (segment.label === blank) continue;
    if (segment.label !== letters[letter])
      throw new Error(`The alignment's ${segment.label} doesn't match ${letters[letter]}.`);
    if (letter === 0) start = index;
    if (letter === letters.length - 1) {
      letter = 0;
      token++;
      intervals.push([start, index]);
      while (token < tokens.length && tokens[token]!.length === 0) {
        intervals.push([index, index]);
        token++;
      }
    } else {
      letter++;
    }
  }
  return intervals.map(([first, last], k) => {
    let span = segments.slice(first, last + 1);
    const before = segments[first - 1];
    if (first > 0 && before?.label === blank) {
      const padStart = k === 0 ? before.start : Math.trunc((before.start + before.end) / 2);
      span = [{ label: blank, start: padStart, end: span[0]!.start }, ...span];
    }
    const after = segments[last + 1];
    if (last + 1 < segments.length && after?.label === blank) {
      const padEnd = k === intervals.length - 1 ? after.end : Math.floor((after.start + after.end) / 2);
      span = [...span, { label: blank, start: span.at(-1)!.end, end: padEnd }];
    }
    return span;
  });
}

/**
 * Word timings from a CTC path over the targets of `words` (`alignerTargets`), `stride` ms per frame, the path's
 * first frame at `offset` seconds: the PoC's `_align_tokens`.
 */
export function timingsFromPath(
  path: ArrayLike<number>,
  scores: Float32Array,
  words: readonly string[],
  language: string,
  stride: number,
  offset: number,
): WordTiming[] {
  const { tokens } = alignerTargets(words, language);
  const spans = getSpans(tokens, mergeRepeats(path));
  const toSec = stride / 1000;
  const blank = LABELS[BLANK]!;
  const out: WordTiming[] = [];
  // preprocess_text's words: the joined words split again (Python's str.split()), "<star>" before each.
  const text = splitWords(words.join(" ")).flatMap((w) => ["<star>", w]);
  text.forEach((word, i) => {
    if (word === "<star>") return;
    const span = spans[i]!;
    const chars = span
      .filter((s) => s.label !== blank && s.label !== "|" && s.label !== " ")
      .map((s): [number, number] => [offset + s.start * toSec, offset + (s.end + 1) * toSec]);
    const start = chars.length ? chars[0]![0] : offset + span[0]!.start * toSec;
    const end = chars.length ? chars.at(-1)![1] : offset + (span.at(-1)!.end + 1) * toSec;
    const score = mean32(scores.subarray(span[0]!.start, span.at(-1)!.end + 1));
    out.push({ text: word, start, end, score, chars });
  });
  return out;
}

/** Join the timings of each word's parts (`wordParts`) back into one timing per lyric word, like `align.align`. */
export function joinParts(
  words: readonly string[],
  parts: readonly string[][],
  flat: readonly WordTiming[],
): WordTiming[] {
  let i = 0;
  return words.map((word, k) => {
    const pieces = flat.slice(i, i + parts[k]!.length);
    i += parts[k]!.length;
    return {
      text: word,
      start: pieces[0]!.start,
      end: pieces.at(-1)!.end,
      score: mean(pieces.map((p) => p.score)),
      chars: pieces.flatMap((p) => p.chars),
    };
  });
}

/** Start time of the character at `fraction` through the word (0..1), for syllable boundaries. */
export function timeAt(word: WordTiming, fraction: number): number {
  if (!word.chars.length) return word.start + fraction * (word.end - word.start);
  const i = Math.min(pyRound(fraction * word.chars.length), word.chars.length - 1);
  return word.chars[i]![0];
}

/**
 * Re-place a line's first or last word when it sits far from the rest of the line (in place): the aligner parks an
 * edge word on unrelated sound (a breath, an ad-lib, the intro) seconds away.
 */
export function pullInEdges(words: WordTiming[], maxGap = 0.8, length = 0.3): void {
  if (words.length < 2) return;
  const [first, second] = [words[0]!, words[1]!];
  if (second.start - first.end > maxGap) {
    first.start = Math.max(first.end, second.start - length);
    first.end = second.start;
    first.chars = [];
  }
  const [last, before] = [words.at(-1)!, words.at(-2)!];
  if (last.start - before.end > maxGap) {
    last.start = before.end;
    last.end = Math.max(last.start + length, Math.min(last.end, last.start + 2.0));
    last.chars = [];
  }
}

/**
 * Move word starts to where singing begins inside the aligned span (in place): the first voiced frame louder than
 * the song's loud singing (90th percentile) minus `drop` dB. `midi` and `rms` are the float32 pitch track.
 */
export function snapToVoice(
  words: WordTiming[],
  midi: Float32Array,
  rms: Float32Array,
  hop: number,
  drop = 20.0,
): void {
  const voiced = Array.from(rms).filter((_, i) => !Number.isNaN(midi[i]!));
  const loud = voiced.length ? Math.fround(percentile32(voiced, 90) - drop) : -Infinity;
  const sung = (i: number) => !Number.isNaN(midi[i]!) && rms[i]! > loud;
  for (const w of words) {
    const a = Math.trunc(w.start / hop);
    const b = Math.min(Math.trunc(w.end / hop), midi.length);
    for (let i = Math.max(a, 0); i < b; i++) {
      if (!sung(i)) continue;
      if (i > a) w.start = i * hop;
      break;
    }
  }
}
