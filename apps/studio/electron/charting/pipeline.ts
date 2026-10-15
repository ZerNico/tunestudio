import { isWord, type WordTiming } from "./align";
/**
 * A chart from a song: the vocal stem and the lyrics in, UltraStar notes on a beat grid out. The auto-tuner PoC's
 * `pipeline.run` with its defaults (learned aligner, syllable-start head, pitch corrector and note ends), stage by
 * stage the ports in this folder; the models run in the native addon behind `ChartEngines`.
 */
import { AlignFailed, alignStage, type LineTimingFit, type LyricLine } from "./align-stage";
import { beatTimes } from "./beats";
import { assign } from "./boundary";
import { fitGrid, makeGrid, toSec, type Grid } from "./grid";
import {
  gameRequest,
  notesFromGame,
  syllableSpans,
  type GameNote,
  type GameRequest,
  type Note,
  type TraceEntry,
} from "./notes";
import { pitchTrack, type FullPitchTrack } from "./pitch-track";
import { applyEnds, applyPitchShifts, endFeatures, featureMatrix, noteFeatures } from "./refiners";
import { estimateScale, tuningOffset } from "./scale";
import { finishLines, fixOctaves, markGolden, splitLines, type HarmonicRatios } from "./song";
import { syllabify } from "./syllables";

/** GAME's sample rate (the vocals it reads) and the CTC classes of the aligner. */
export const GAME_SAMPLE_RATE = 44_100;
const ALIGNER_CLASSES = 31;

/** The models the chart needs, as the native addon runs them (model paths bound in). */
export interface ChartEngines {
  trackPitch(vocals16k: Float32Array): Promise<Float32Array>;
  beatLogits(mix22k: Float32Array): Promise<{ beat: Float32Array; downbeat: Float32Array }>;
  alignerOutputs(
    vocals16k: Float32Array,
    onProgress: (percent: number) => void,
  ): Promise<{ emissions: Float32Array; frames: number; syllableStarts: Float32Array }>;
  /** Throws AlignFailed when the text can't fit in the frames. */
  forcedAlign(
    emissions: Float32Array,
    classes: number,
    from: number,
    to: number,
    targets: Int32Array,
  ): Promise<{ path: Int32Array; scores: Float32Array }>;
  transcribeNotes(
    vocals44k: Float32Array,
    requests: { from: number; to: number; known: number[] }[],
    language: number,
    onProgress: (percent: number) => void,
  ): Promise<{ counts: number[]; starts: Float64Array; ends: Float64Array; voiced: Uint8Array; midi: Float64Array }>;
  harmonicRatios(vocals44k: Float32Array, notes: { start: number; end: number; midi: number }[]): Promise<Float64Array>;
  predictPitchShifts(features: Float32Array): Promise<Float32Array>;
  predictNoteEnds(features: Float32Array): Promise<Float32Array>;
}

/** The language of the lyrics: its name as the syllable rules know it ("english") and its ISO 639-3 code ("eng"). */
export interface ChartLanguage {
  name: string;
  code: string;
}

export interface ChartInput {
  /** The vocal stem, mono, at 16 kHz (pitch, aligner) and 44.1 kHz (GAME, harmonics). */
  vocals16k: Float32Array;
  vocals44k: Float32Array;
  /** The whole song, mono, at 22.05 kHz (beats). */
  mix22k: Float32Array;
  lines: LyricLine[];
  language: ChartLanguage;
}

/** The stages, for progress. */
export type ChartStep = "melody" | "beat" | "timing" | "notes" | "finishing";

export interface ChartResult {
  /** The grid the notes are on (unrounded; the headers round it). */
  grid: Grid;
  lines: Note[][];
  /** The beat each line switches to the next at (one fewer than lines). */
  breaks: number[];
  /** How LRCLIB's line times were used, when the lyrics had them. */
  fit: LineTimingFit | null;
  /** The singer's pitch it followed (kept with the project for the editor). */
  track: FullPitchTrack;
}

/** GAME's language ids (its config): English has its own, everything else is universal. */
export function gameLanguage(language: ChartLanguage): number {
  return language.code === "eng" ? 1 : 0;
}

/** Backing vocals in brackets ("(oh oh)") left out: forcing them into the alignment drags the next lines along. */
export function dropBacking(lines: readonly LyricLine[]): LyricLine[] {
  return lines
    .map((line) => ({
      ...line,
      text: line.text
        .replace(/\([^)]*\)?/gu, " ")
        .split(/\s+/u)
        .filter(Boolean)
        .join(" "),
    }))
    .filter((line) => line.text.split(" ").some((w) => isWord(w)));
}

export async function makeChart(
  input: ChartInput,
  engines: ChartEngines,
  onStep: (step: ChartStep, percent: number) => void = () => {},
): Promise<ChartResult> {
  onStep("melody", 0);
  const track: FullPitchTrack = pitchTrack(await engines.trackPitch(input.vocals16k), input.vocals16k);

  onStep("beat", 0);
  const logits = await engines.beatLogits(input.mix22k);
  const { beats, downbeats } = beatTimes(logits.beat, logits.downbeat);
  const { bpm, t0 } = fitGrid(beats, downbeats);

  onStep("timing", 0);
  const aligner = await engines.alignerOutputs(input.vocals16k, (percent) => onStep("timing", percent));
  const forcedAlign = async (from: number, to: number, ids: Int32Array) => {
    try {
      return await engines.forcedAlign(aligner.emissions, ALIGNER_CLASSES, from, to, ids);
    } catch (error) {
      throw new AlignFailed(error instanceof Error ? error.message : String(error));
    }
  };
  const { aligned, fit } = await alignStage({
    lines: dropBacking(input.lines),
    language: input.language.code,
    frames: aligner.frames,
    forcedAlign,
    midi: track.midi,
    rms: track.rms,
    songEnd: track.times.at(-1)!,
  });
  const first = aligned.flat()[0];
  if (!first) throw new AlignFailed("None of the lyrics could be found in the vocals.");

  onStep("notes", 0);
  const grid = makeGrid(bpm, t0, first.start);
  const tuning = tuningOffset(track.midi);
  const scale = estimateScale(track.midi, tuning);
  const lines = linesWithWords(aligned, input.language, aligner.syllableStarts);
  const requests = lines.map(({ spans }) => gameRequest(spans, input.vocals44k.length, GAME_SAMPLE_RATE));
  const wanted = requests.flatMap((request) => (request ? [request] : []));
  const raw = await engines.transcribeNotes(
    input.vocals44k,
    wanted.map(({ from, to, known }) => ({ from, to, known })),
    gameLanguage(input.language),
    (percent) => onStep("notes", percent),
  );
  const byRequest = splitGameNotes(raw);
  let next = 0;
  const outLines: { notes: Note[]; trace: TraceEntry[] }[] = lines.map(({ spans }, i) => {
    const request = requests[i];
    if (!request) return { notes: [], trace: [] };
    return notesFromGame(spans, byRequest[next++]!, request, grid, { scale });
  });

  // The learned corrections, line by line (their features look at a line's neighbouring notes), in one model run each.
  const pitchFeatures = outLines.flatMap(({ notes, trace }) => noteFeatures(notes, trace, track, tuning, scale));
  const shifts = pitchFeatures.length
    ? await engines.predictPitchShifts(featureMatrix(pitchFeatures))
    : new Float32Array();
  let at = 0;
  for (const { notes } of outLines) {
    applyPitchShifts(notes, shifts.subarray(at * 5, (at + notes.length) * 5));
    at += notes.length;
  }
  const endRows = outLines.flatMap(({ notes, trace }) =>
    endFeatures(noteFeatures(notes, trace, track, tuning, scale), trace),
  );
  const deltas = endRows.length ? await engines.predictNoteEnds(featureMatrix(endRows)) : new Float32Array();
  at = 0;
  for (const { notes, trace } of outLines) {
    applyEnds(notes, trace, deltas.subarray(at, at + notes.length), grid);
    at += notes.length;
  }

  onStep("finishing", 0);
  const noteLines = outLines.map(({ notes }) => notes);
  const sung = noteLines.flat().filter((n) => n.type === "normal" || n.type === "golden");
  const ratios = await engines.harmonicRatios(
    input.vocals44k,
    sung.map((n) => ({ start: toSec(grid, n.start), end: toSec(grid, n.start + n.length), midi: n.pitch + 60 })),
  );
  fixOctaves(noteLines, grid, track, tuning, harmonicPairs(ratios));
  markGolden(noteLines, grid, track, tuning);
  const finished = finishLines(splitLines(noteLines, grid), grid);
  return { grid, lines: finished.lines, breaks: finished.breaks, fit, track };
}

/** Each aligned line's syllable spans, with their starts moved to the syllable-start head's peaks. */
function linesWithWords(aligned: WordTiming[][], language: ChartLanguage, syllableStarts: Float32Array) {
  return aligned.flatMap((words, li) => {
    if (!words.length) return [];
    const nextLine = aligned.slice(li + 1).find((ws) => ws.length)?.[0]?.start ?? null;
    const spans = syllableSpans(
      words,
      words.map((w) => syllabify(w.text, language.name)),
      nextLine,
    );
    // One-to-one within ±0.3 s, cost 0.5: the PoC's defaults.
    const starts = assign(
      spans.map((span) => span.start),
      syllableStarts,
      0.3,
      0.3,
      0.5,
    );
    spans.forEach((span, i) => (span.start = starts[i]!));
    for (let i = 0; i + 1 < spans.length; i++) spans[i]!.end = Math.min(spans[i]!.end, spans[i + 1]!.start);
    return [{ spans }];
  });
}

export function splitGameNotes(raw: {
  counts: number[];
  starts: Float64Array;
  ends: Float64Array;
  voiced: Uint8Array;
  midi: Float64Array;
}): GameNote[][] {
  let at = 0;
  return raw.counts.map((count) => {
    const notes = Array.from({ length: count }, (_, k): GameNote => ({
      start: raw.starts[at + k]!,
      end: raw.ends[at + k]!,
      voiced: raw.voiced[at + k] === 1,
      midi: raw.midi[at + k]!,
    }));
    at += count;
    return notes;
  });
}

/** [down, up] pairs, null where a note was too short to measure (the native side gives NaN). */
export function harmonicPairs(ratios: Float64Array): HarmonicRatios {
  return Array.from({ length: ratios.length / 2 }, (_, i) =>
    Number.isNaN(ratios[2 * i]!) ? null : ([ratios[2 * i]!, ratios[2 * i + 1]!] as [number, number]),
  );
}

export type { GameRequest };
