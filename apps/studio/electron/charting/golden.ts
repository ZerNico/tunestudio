/**
 * Golden notes (double points), as charters pick them: gradient-boosted trees (`golden.onnx` of tunestudio-note-refiners,
 * run by the native addon) score how likely a charter gilds each note from its features (its length, how steadily and
 * loudly it is sung, its pitch and its place against the song, its line, its phrase and its neighbours, its melisma),
 * and the song gets as many golden notes as those probabilities add up to, the most likely first, picked by a few
 * plain rules. A port of the training pipeline's `pipeline.golden` (`structure`, `features`, `pick` and `mark` with
 * the "model" method).
 *
 * It runs on the finished lines (after line splitting and `finishLines`), so "the last note of a line" is the line the
 * player sees. The features are float64 as in the Python until the end, where it casts them to float32; the pitch
 * track is float32 there as here.
 */
import { toSec, type Grid } from "./grid";
import type { Note } from "./notes";
import { floorMod, mean, mean32, median, pairwiseSum, pyRound, std } from "./numpy";
import type { PitchTrack } from "./refiners";

/** The pitch track's frame length in seconds. */
const HOP = 0.01;
/** Seconds of rest that end a phrase. */
const PHRASE_REST = 0.3;
/** Chart beats per real beat, for the beat phase. */
const UNITS_PER_BEAT = 16;

/** The features of a note, in the model's order (`pipeline.golden.FEATURES`). */
export const FEATURES = [
  // length
  "sec",
  "log_sec",
  "len_rank",
  "vs_line_max",
  "vs_phrase_max",
  "vs_local",
  "vs_prev",
  "vs_next",
  // how it is sung
  "on_pitch",
  "on_frac",
  "pitch_spread",
  "voiced",
  "wobble",
  "slope",
  "loud",
  "loud_line",
  "loud_phrase",
  // pitch
  "rel_pitch",
  "pitch_rank",
  "below_line_high",
  "rel_line",
  "line_peak",
  "phrase_peak",
  "below_phrase_peak",
  "local_peak",
  "rise",
  "fall",
  // place
  "line_last",
  "line_from_end",
  "line_pos",
  "line_notes",
  "log_line_sec",
  "phrase_first",
  "phrase_last",
  "phrase_from_end",
  "phrase_notes",
  "log_phrase_sec",
  "gap_before",
  "gap_after",
  "song_pos",
  "beat_sin",
  "beat_cos",
  // syllables and melismas
  "tilde",
  "word_end",
  "log_word_sec",
  "mel_size",
  "mel_index",
  "log_mel_sec",
  "mel_range",
  // the song
  "log_song_notes",
] as const;

export type Feature = (typeof FEATURES)[number];

/** How golden notes are picked from the probabilities (`pick`). */
export interface PickOptions {
  scale: number;
  runs: number | null;
  spread: number | null;
  start: "syllable" | "any";
  repeat_cap: number | null;
}

/** How the shipped model's golden notes are picked (`pipeline.golden.PICK`). */
export const PICK: PickOptions = { scale: 1, runs: 0.7, spread: 0.25, start: "syllable", repeat_cap: null };

/** A pitch track with the vocals' loudness (dB per frame), when there is one. */
export type LoudTrack = PitchTrack & { rms?: Float32Array | null };

const isSung = (n: Note) => n.type === "normal" || n.type === "golden";

/** Every normal or golden note with its line's index, in order. */
export function sungNotes(lines: readonly Note[][]): { line: number; note: Note }[] {
  return lines.flatMap((line, li) => line.filter(isSung).map((note) => ({ line: li, note })));
}

/**
 * A line's lyrics for finding repeated lines: its sung notes' text without "~", lower case, letters and digits only
 * ("Wann ist der Mann~ ein Mann?~~" gives "wannistdermanneinmann").
 */
export function lyricsKey(line: readonly Note[]): string {
  const text = line
    .filter(isSung)
    .map((n) => n.text)
    .join("")
    .replaceAll("~", "")
    .toLowerCase();
  return [...text].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");
}

/** Per sung note: what the features and the pick need to know about the song's shape. */
export interface Structure {
  /** Seconds. */
  start: Float64Array;
  end: Float64Array;
  midi: Float64Array;
  /** The note's start in chart beats. */
  beat: Float64Array;
  line: Int32Array;
  phrase: Int32Array;
  melisma: Int32Array;
  tilde: Uint8Array;
  wordEnd: Uint8Array;
  /** The index of the first line with the same lyrics (at least 4 letters), else the note's own line. */
  text: Int32Array;
}

/**
 * Per sung note: its times, pitch, line, phrase (notes between line breaks or rests of at least 0.3 s) and melisma (a
 * syllable's note and the "~" notes after it in the same phrase), whether it is a "~" or ends a word, and which
 * lines share its lyrics.
 */
export function structure(lines: readonly Note[][], grid: Grid): Structure {
  const notes = sungNotes(lines);
  const n = notes.length;
  const s: Structure = {
    start: Float64Array.from(notes, ({ note }) => toSec(grid, note.start)),
    end: Float64Array.from(notes, ({ note }) => toSec(grid, note.start + note.length)),
    midi: Float64Array.from(notes, ({ note }) => note.pitch + 60),
    beat: Float64Array.from(notes, ({ note }) => note.start),
    line: Int32Array.from(notes, ({ line }) => line),
    phrase: new Int32Array(n),
    melisma: new Int32Array(n),
    tilde: Uint8Array.from(notes, ({ note }) => (note.text.trim().startsWith("~") ? 1 : 0)),
    wordEnd: new Uint8Array(n),
    text: new Int32Array(n),
  };
  const newPhrase = (k: number) => k === 0 || s.line[k] !== s.line[k - 1] || s.start[k]! - s.end[k - 1]! >= PHRASE_REST;
  let phrase = -1;
  let melisma = -1;
  for (let k = 0; k < n; k++) {
    if (newPhrase(k)) phrase++;
    // A "~" that starts a phrase starts its own melisma.
    if (!s.tilde[k] || newPhrase(k)) melisma++;
    s.phrase[k] = phrase;
    s.melisma[k] = melisma;
    s.wordEnd[k] = notes[k]!.note.text.endsWith(" ") || k + 1 === n || newPhrase(k + 1) ? 1 : 0;
  }
  const firstWith = new Map<string, number>();
  const texts = lines.map((line, li) => {
    const key = lyricsKey(line);
    if ([...key].length < 4) return li;
    if (!firstWith.has(key)) firstWith.set(key, li);
    return firstWith.get(key)!;
  });
  for (let k = 0; k < n; k++) s.text[k] = texts[s.line[k]!]!;
  return s;
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

/** Percentile rank in [0, 1], equal values sharing their mean rank. */
function rank(x: Float64Array): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  if (n < 2) return out;
  const order = Array.from(x.keys()).toSorted((a, b) => x[a]! - x[b]!);
  for (let first = 0; first < n;) {
    let last = first;
    while (last + 1 < n && x[order[last + 1]!] === x[order[first]!]) last++;
    const r = (first + (last - first) / 2) / (n - 1);
    for (let i = first; i <= last; i++) out[order[i]!] = r;
    first = last + 1;
  }
  return out;
}

/** [from, to) of each run of equal consecutive ids. */
function groups(ids: Int32Array): [number, number][] {
  const out: [number, number][] = [];
  for (let from = 0; from < ids.length;) {
    let to = from + 1;
    while (to < ids.length && ids[to] === ids[from]) to++;
    out.push([from, to]);
    from = to;
  }
  return out;
}

const clip = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The largest of values[from..to). */
function max(values: Float64Array, from: number, to: number): number {
  let most = -Infinity;
  for (let i = from; i < to; i++) most = Math.max(most, values[i]!);
  return most;
}

/**
 * How each note is sung, from the pitch track: seconds within half a semitone of the note's pitch class, the spread
 * of the distance to it, the voiced share, the wobble around a straight line through the sung pitch and that line's
 * slope (semitones per second), and the mean loudness (dB, NaN without frames or a loudness track).
 */
function sungStats(s: Structure, track: LoudTrack, tuning: number) {
  const n = s.start.length;
  const out = {
    onPitch: new Float64Array(n),
    pitchSpread: new Float64Array(n),
    voiced: new Float64Array(n),
    wobble: new Float64Array(n),
    slope: new Float64Array(n),
    loud: new Float64Array(n).fill(Number.NaN),
  };
  const shift = Math.fround(tuning);
  for (let k = 0; k < n; k++) {
    const i = searchsorted(track.times, s.start[k]!);
    const j = searchsorted(track.times, s.end[k]!);
    const v: number[] = [];
    for (let f = i; f < j; f++) {
      const m = track.midi[f]!;
      if (!Number.isNaN(m)) v.push(Math.fround(m - shift));
    }
    const d = v.map((x) => {
      const r = floorMod(Math.abs(x - s.midi[k]!), 12);
      return Math.min(r, 12 - r);
    });
    out.onPitch[k] = d.filter((x) => x <= 0.5).length * HOP;
    out.pitchSpread[k] = d.length >= 3 ? std(d) : 6.0;
    out.voiced[k] = j > i ? v.length / (j - i) : 0;
    if (v.length >= 4) {
      // np.polyfit(t, v, 1), as a least-squares line around the means.
      const t = v.map((_, f) => f * HOP);
      const tMean = mean(t);
      const vMean = mean(v);
      let tt = 0;
      let tv = 0;
      for (let f = 0; f < v.length; f++) {
        tt += (t[f]! - tMean) ** 2;
        tv += (t[f]! - tMean) * (v[f]! - vMean);
      }
      const slope = tv / tt;
      const icpt = vMean - slope * tMean;
      out.slope[k] = Math.min(Math.abs(slope), 40);
      out.wobble[k] = Math.min(std(v.map((x, f) => x - (slope * t[f]! + icpt))), 3);
    }
    if (track.rms && j > i) out.loud[k] = mean32(track.rms.subarray(i, j));
  }
  return out;
}

/** One row of FEATURES per sung note, in `sungNotes` order: a float32 matrix, row after row. */
export function features(lines: readonly Note[][], grid: Grid, track: LoudTrack, tuning: number): Float32Array {
  const s = structure(lines, grid);
  const n = s.start.length;
  const width = FEATURES.length;
  if (n === 0) return new Float32Array(0);
  const F = Object.fromEntries(FEATURES.map((name) => [name, new Float64Array(n)])) as Record<Feature, Float64Array>;
  const { midi, start, end } = s;
  const sec = Float64Array.from(start, (a, k) => Math.max(end[k]! - a, 1e-3));
  const sung = sungStats(s, track, tuning);
  const heard = Array.from(sung.loud).filter((x) => !Number.isNaN(x));
  const songLoud = heard.length ? median(heard) : Number.NaN;
  // A note without frames is as quiet as a rest.
  const loud = Float64Array.from(sung.loud, (x) => (!heard.length ? 0 : Number.isNaN(x) ? -30 : x - songLoud));
  const sameLine = (a: number, b: number) => a >= 0 && b < n && s.line[a] === s.line[b];

  for (let k = 0; k < n; k++) {
    F.sec[k] = sec[k]!;
    F.log_sec[k] = Math.log(sec[k]!);
    const local = sec.subarray(Math.max(0, k - 5), Math.min(n, k + 6));
    F.vs_local[k] = Math.log(sec[k]! / median(local));
    const prev = k > 0 ? k - 1 : 0;
    const next = k + 1 < n ? k + 1 : n - 1;
    F.vs_prev[k] = sameLine(k - 1, k) ? Math.log((sec[k]! + 0.03) / (sec[prev]! + 0.03)) : 0;
    F.vs_next[k] = sameLine(k, k + 1) ? Math.log((sec[k]! + 0.03) / (sec[next]! + 0.03)) : 0;

    F.on_pitch[k] = sung.onPitch[k]!;
    F.on_frac[k] = sung.onPitch[k]! / Math.max(sec[k]!, HOP);
    F.pitch_spread[k] = sung.pitchSpread[k]!;
    F.voiced[k] = sung.voiced[k]!;
    F.wobble[k] = sung.wobble[k]!;
    F.slope[k] = sung.slope[k]!;
    F.loud[k] = loud[k]!;

    F.rise[k] = sameLine(k - 1, k) ? clip(midi[k]! - midi[prev]!, -12, 12) : 0;
    F.fall[k] = sameLine(k, k + 1) ? clip(midi[k]! - midi[next]!, -12, 12) : 0;
    const around = [...midi.subarray(Math.max(0, k - 2), k), ...midi.subarray(k + 1, k + 3)];
    F.local_peak[k] = around.length ? clip(midi[k]! - Math.max(...around), -12, 12) : 0;
  }
  F.len_rank.set(rank(sec));
  const songPitch = median(midi);
  for (let k = 0; k < n; k++) F.rel_pitch[k] = clip(midi[k]! - songPitch, -12, 12);
  F.pitch_rank.set(rank(midi));

  for (const [from, to] of groups(s.line)) {
    const m = to - from;
    const longest = max(sec, from, to);
    const high = max(midi, from, to);
    const lineLoud = median(loud.subarray(from, to));
    const linePitch = mean(midi.subarray(from, to));
    const lineSec = Math.log(Math.max(end[to - 1]! - start[from]!, 0.05));
    for (let k = from; k < to; k++) {
      const i = k - from;
      F.vs_line_max[k] = Math.log(sec[k]! / longest);
      F.loud_line[k] = loud[k]! - lineLoud;
      F.below_line_high[k] = high - midi[k]!;
      F.rel_line[k] = midi[k]! - linePitch;
      F.line_peak[k] = midi[k] === high ? 1 : 0;
      F.line_from_end[k] = Math.min(m - 1 - i, 4);
      F.line_pos[k] = i / Math.max(m - 1, 1);
      F.line_notes[k] = m;
      F.log_line_sec[k] = lineSec;
    }
    F.line_last[to - 1] = 1;
  }
  for (const [from, to] of groups(s.phrase)) {
    const m = to - from;
    const longest = max(sec, from, to);
    const high = max(midi, from, to);
    const phraseLoud = median(loud.subarray(from, to));
    const phraseSec = Math.log(Math.max(end[to - 1]! - start[from]!, 0.05));
    for (let k = from; k < to; k++) {
      F.vs_phrase_max[k] = Math.log(sec[k]! / longest);
      F.loud_phrase[k] = loud[k]! - phraseLoud;
      F.phrase_peak[k] = midi[k] === high ? 1 : 0;
      F.below_phrase_peak[k] = high - midi[k]!;
      F.phrase_from_end[k] = Math.min(to - 1 - k, 4);
      F.phrase_notes[k] = m;
      F.log_phrase_sec[k] = phraseSec;
    }
    F.phrase_first[from] = 1;
    F.phrase_last[to - 1] = 1;
  }
  for (const [from, to] of groups(s.melisma)) {
    const melSec = Math.log(Math.max(end[to - 1]! - start[from]!, 0.05));
    const range = Math.min(max(midi, from, to) - Math.min(...midi.subarray(from, to)), 12);
    for (let k = from; k < to; k++) {
      F.mel_size[k] = Math.min(to - from, 8);
      F.mel_index[k] = Math.min(k - from, 7);
      F.log_mel_sec[k] = melSec;
      F.mel_range[k] = range;
    }
  }
  // Words: a word runs to its note with a trailing space (or the phrase's end).
  let w0 = 0;
  for (let k = 0; k < n; k++) {
    if (!s.wordEnd[k]) continue;
    F.log_word_sec.fill(Math.log(Math.max(end[k]! - start[w0]!, 0.05)), w0, k + 1);
    w0 = k + 1;
  }

  const first = start[0]!;
  const last = Math.max(end[n - 1]!, first + 1);
  for (let k = 0; k < n; k++) {
    F.gap_before[k] = clip(k > 0 ? start[k]! - end[k - 1]! : 3, 0, 3);
    F.gap_after[k] = clip(k + 1 < n ? start[k + 1]! - end[k]! : 3, 0, 3);
    F.song_pos[k] = (start[k]! - first) / (last - first);
    const phase = (2 * Math.PI * floorMod(s.beat[k]!, UNITS_PER_BEAT)) / UNITS_PER_BEAT;
    F.beat_sin[k] = Math.sin(phase);
    F.beat_cos[k] = Math.cos(phase);
    F.tilde[k] = s.tilde[k]!;
    F.word_end[k] = s.wordEnd[k]!;
    F.log_song_notes[k] = Math.log(n);
  }

  const X = new Float32Array(n * width);
  FEATURES.forEach((name, c) => {
    for (let k = 0; k < n; k++) X[k * width + c] = F[name][k]!;
  });
  return X;
}

/**
 * How likely a charter gilds each note, from `golden.onnx`'s output (per note the probabilities of staying normal and of
 * being golden). As float64, so their sum (the golden count) adds up like the Python's.
 */
export function goldenProbabilities(output: Float32Array): Float64Array {
  return Float64Array.from({ length: output.length / 2 }, (_, k) => output[2 * k + 1]!);
}

/**
 * Indices of the golden notes: about round(`scale` × the sum of `proba`) of them (the expected number of golden notes,
 * so a song where nothing stands out gets few), the most likely first. `s` is the song's `structure`.
 *
 * `start` "syllable": a group always starts on a syllable's note. Each melisma is one candidate: its first notes up to
 * the one where their mean probability is highest (the longest of equal means), then on through every next note
 * that keeps the mean at least `runs` times that best mean. Candidates are taken by that mean, whole, so the last one
 * may pass the number by a note or two. `start` "any": every note is a candidate on its own; with `runs`, a picked
 * note brings its melisma along when the melisma's mean probability is at least `runs` times its own, cut at the
 * number.
 *
 * `spread`: no tenth of the song takes more than this share of the golden notes (at least one). `repeat_cap`: at most
 * this many lines with the same lyrics get golden notes.
 */
export function pick(proba: Float64Array, s: Structure, options: PickOptions): number[] {
  const { scale, runs, spread, start, repeat_cap: repeatCap } = options;
  const n = proba.length;
  const want = pyRound(scale * pairwiseSum(proba));
  if (want <= 0 || n === 0) return [];
  const first = s.start[0]!;
  const last = Math.max(s.end[n - 1]!, first + 1);
  const cap = spread ? Math.max(1, Math.ceil(spread * want)) : want;
  let candidates: [number, number[]][];
  if (start === "syllable") {
    candidates = groups(s.melisma).map(([from, to]) => {
      const means: number[] = [];
      let sum = 0;
      for (let k = from; k < to; k++) {
        sum += proba[k]!;
        means.push(sum / (k - from + 1));
      }
      let j = 0;
      for (let i = 1; i < means.length; i++) if (means[i]! >= means[j]!) j = i;
      if (runs !== null) while (j + 1 < means.length && means[j + 1]! >= runs * means[j]!) j++;
      return [means[j]!, Array.from({ length: j + 1 }, (_, i) => from + i)];
    });
  } else if (start === "any") {
    candidates = Array.from(proba, (p, k) => [p, [k]]);
  } else {
    throw new Error(`Unknown golden pick start ${String(start)}.`);
  }
  const taken = new Uint8Array(n);
  let count = 0;
  const perTenth = Array.from({ length: 10 }, () => 0);
  // Lyrics: the lines with them that have golden notes.
  const gilded = new Map<number, Set<number>>();
  const order = Array.from(candidates.keys()).toSorted((a, b) => candidates[b]![0] - candidates[a]![0]);
  for (const c of order) {
    const left = want - count;
    if (left <= 0) break;
    let spot = candidates[c]![1];
    const k = spot[0]!;
    if (taken[k]) continue;
    if (start === "any" && runs !== null) {
      const group: number[] = [];
      for (let i = 0; i < n; i++) if (s.melisma[i] === s.melisma[k]) group.push(i);
      if (group.length > 1 && mean(group.map((i) => proba[i]!)) >= runs * proba[k]!)
        spot = group.filter((i) => !taken[i]).slice(0, left);
    }
    const tenth = Math.min(9, Math.trunc(10 * ((s.start[k]! - first) / (last - first))));
    if (perTenth[tenth]! >= cap) continue;
    const line = s.line[k]!;
    const same = gilded.get(s.text[k]!) ?? new Set<number>();
    gilded.set(s.text[k]!, same);
    if (repeatCap !== null && !same.has(line) && same.size >= repeatCap) continue;
    for (const i of spot) {
      if (!taken[i]) count++;
      taken[i] = 1;
    }
    perTenth[tenth]! += spot.length;
    same.add(line);
  }
  return Array.from(taken.keys()).filter((i) => taken[i]);
}

/**
 * Mark the golden notes of finished lines (in place), replacing any there were. `predict` runs `golden.onnx` on the
 * notes' features.
 */
export async function markGolden(
  lines: Note[][],
  grid: Grid,
  track: LoudTrack,
  tuning: number,
  predict: (features: Float32Array) => Promise<Float32Array>,
): Promise<void> {
  for (const line of lines) for (const n of line) if (n.type === "golden") n.type = "normal";
  const notes = sungNotes(lines);
  if (!notes.length) return;
  const proba = goldenProbabilities(await predict(features(lines, grid, track, tuning)));
  for (const k of pick(proba, structure(lines, grid), PICK)) notes[k]!.note.type = "golden";
}
