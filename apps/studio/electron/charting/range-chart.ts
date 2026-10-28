import { rangeProblem, type TimeRange } from "../../src/lib/chart-range";
import type { RangeChart } from "../../src/lib/native/types";
import { isWord, wordParts } from "./align";
import { AlignFailed } from "./align-stage";
import { alignerTokens, splitWords } from "./aligner-text";
import { toSec, unit, type Grid } from "./grid";
import { GAME_SAMPLE_RATE, makeChart, type ChartEngines, type ChartLanguage, type ChartStep } from "./pipeline";
import { PITCH_SAMPLE_RATE } from "./pitch-track";
import { lineBreaks } from "./song";

export type RangeEngines = Omit<ChartEngines, "beatLogits" | "predictGolden">;

const fail = () => {
  throw new AlignFailed("The lyrics don't fit in this range. Choose more time or fewer words.");
};
const text = (value: string) => value.replaceAll("~", "").replace(/\s+/gu, " ").trim();

/** A passage on the project's existing grid. All crops share the same sample-exact origin. */
export async function chartRange(
  input: {
    vocals16k: Float32Array;
    vocals44k: Float32Array;
    range: TimeRange;
    lines: readonly string[];
    language: ChartLanguage;
    grid: Grid;
    songMidi: Float32Array;
  },
  engines: RangeEngines,
  onStep: (step: ChartStep, percent: number) => void = () => {},
  signal?: AbortSignal,
): Promise<Omit<RangeChart, "vocals">> {
  signal?.throwIfAborted();
  const problem = rangeProblem(input.range, input.lines);
  if (problem) throw new AlignFailed(problem);
  for (const line of input.lines) {
    for (const word of splitWords(line).filter(isWord)) {
      const parts = wordParts(word);
      if (!parts.length || parts.some((part) => !/[a-z]/u.test(alignerTokens(part, input.language.code).join(""))))
        throw new AlignFailed("Write numbers as words and use Latin letters.");
    }
  }
  const { grid } = input;
  const duration = Math.min(input.vocals16k.length / PITCH_SAMPLE_RATE, input.vocals44k.length / GAME_SAMPLE_RATE);
  // A range to the song's end can pass the decoded samples slightly (stored durations round up): nothing is sung there.
  const range = { start: input.range.start, end: Math.min(input.range.end, duration) };
  if (!Number.isFinite(grid.bpm) || grid.bpm <= 0 || !Number.isFinite(grid.gap) || range.end <= range.start)
    throw new AlignFailed("Choose a range inside the vocals on a valid song grid.");
  const firstTick = Math.ceil((range.start - grid.gap) / unit(grid) - 1e-6);
  const endTick = Math.floor((range.end - grid.gap) / unit(grid) + 1e-6);
  if (endTick <= firstTick) throw new AlignFailed("The range is shorter than one grid step.");
  const offset = Math.max(0, Math.floor((range.start - 1) * 50) / 50);
  const stop = Math.min(duration, range.end + 1);
  const crop = (samples: Float32Array, rate: number) =>
    samples.subarray(Math.round(offset * rate), Math.floor(stop * rate));
  const local = { start: range.start - offset, end: range.end - offset };
  const result = await makeChart(
    {
      vocals16k: crop(input.vocals16k, PITCH_SAMPLE_RATE),
      vocals44k: crop(input.vocals44k, GAME_SAMPLE_RATE),
      mix22k: new Float32Array(),
      lines: input.lines.map((text) => ({ text, start: null, end: null })),
      language: input.language,
      passage: { ...local, grid: { bpm: grid.bpm, gap: grid.gap - offset }, songMidi: input.songMidi },
    },
    {
      ...engines,
      beatLogits: () => {
        throw new Error("Range charting must not fit a new grid");
      },
      predictGolden: () => {
        throw new Error("Range charting leaves golden notes alone");
      },
    },
    onStep,
    signal,
  );
  signal?.throwIfAborted();
  if (!result.track.midi.subarray(Math.ceil(local.start * 100), Math.floor(local.end * 100)).some(Number.isFinite))
    throw new AlignFailed("Nothing is sung in this range.");
  if (result.lines.length !== input.lines.length) fail();
  let previousEnd = firstTick;
  result.lines.forEach((notes, i) => {
    const expected = splitWords(input.lines[i]!).join(" ");
    if (!notes.length || !expected || text(notes.map((note) => note.text).join("")) !== text(expected)) fail();
    for (const note of notes) {
      const end = Math.min(endTick, note.start + note.length);
      note.start = Math.max(firstTick, note.start);
      note.length = end - note.start;
      if (
        !Number.isInteger(note.start) ||
        !Number.isInteger(note.length) ||
        note.length < 1 ||
        note.start < previousEnd ||
        !Number.isInteger(note.pitch)
      )
        fail();
      previousEnd = end;
    }
  });
  return {
    bpm: grid.bpm,
    gap: grid.gap,
    lines: result.lines.map((notes) => ({
      notes: notes.map((note) => ({
        start: toSec(grid, note.start),
        duration: note.length * unit(grid),
        pitch: note.pitch + 60,
        lyric: note.text,
        type: "normal" as const,
      })),
    })),
    breaks: lineBreaks(result.lines, grid).map((beat) => toSec(grid, beat)),
  };
}
