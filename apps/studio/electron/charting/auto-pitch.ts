/**
 * Auto pitch: the pitch of notes that are already placed, worked out the way the chart is made (pipeline.ts) but with
 * the notes' timing kept. For the lines the notes are in (one singer's, with the lines around them as context): FCPE
 * over that stretch of the vocals, GAME on the lines with asked-for notes, the notes' spans as known boundaries (each note takes its longest voiced GAME note; the sung pitch's median where GAME found
 * none), snapped to the song's key, then the learned pitch corrector and the octave fix with the lines' other notes as
 * context. Only the asked-for notes get a pitch; nothing is written anywhere.
 */
import { type Grid, toBeat } from "./grid";
import { gameRequest, type Note, type SyllableSpan, type TraceEntry } from "./notes";
import { median32 } from "./numpy";
import {
  type ChartEngines,
  type ChartLanguage,
  GAME_SAMPLE_RATE,
  gameLanguage,
  harmonicPairs,
  splitGameNotes,
} from "./pipeline";
import { PITCH_SAMPLE_RATE, pitchTrack } from "./pitch-track";
import { applyPitchShifts, featureMatrix, noteFeatures, PITCH_SHIFTS, type PitchTrack } from "./refiners";
import { estimateScale, snap, tuningOffset } from "./scale";
import { fixOctaves } from "./song";

/** Audio around the lines FCPE also hears, so the first and last notes have their whole frames (seconds). */
const MARGIN = 0.5;
/** The least audio FCPE takes (samples at 16 kHz). */
const MIN_PITCH_SAMPLES = 1024;

/** A note of a line: its id, seconds, current pitch (MIDI) and type. */
export interface PitchNote {
  id: number;
  start: number;
  end: number;
  pitch: number;
  type: Note["type"];
}

export interface AutoPitchInput {
  vocals16k: Float32Array;
  vocals44k: Float32Array;
  /** One singer's lines the notes are in, in time order, with all their notes (the others, and lines without asked-for
   * notes, are context). */
  lines: readonly (readonly PitchNote[])[];
  /** The notes to find the pitch of. */
  notes: ReadonlySet<number>;
  grid: Grid;
  /** The whole song's sung pitch (MIDI, NaN where unvoiced), for its tuning and key. */
  songMidi: Float32Array;
  language: ChartLanguage;
}

export type AutoPitchEngines = Pick<
  ChartEngines,
  "trackPitch" | "transcribeNotes" | "harmonicRatios" | "predictPitchShifts"
>;

/** The voiced frames' median between two times, or NaN. */
function sungMedian(track: PitchTrack, start: number, end: number): number {
  const voiced: number[] = [];
  for (let i = 0; i < track.times.length; i++) {
    const t = track.times[i]!;
    if (t >= end) break;
    if (t >= start && !Number.isNaN(track.midi[i]!)) voiced.push(track.midi[i]!);
  }
  return voiced.length >= 3 ? median32(Float32Array.from(voiced)) : Number.NaN;
}

/** The new pitch (MIDI) of each asked-for note that has something sung to go by. */
export async function autoPitch(
  input: AutoPitchInput,
  engines: AutoPitchEngines,
  onProgress: (percent: number) => void = () => {},
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  const lines = input.lines.map((line) => line.toSorted((a, b) => a.start - b.start)).filter((line) => line.length);
  const all = lines.flat();
  if (!all.some((note) => input.notes.has(note.id))) return new Map();

  // The sung pitch over the lines (FCPE on that stretch), and the song's tuning and key.
  const from = Math.max(0, Math.min(...all.map((note) => note.start)) - MARGIN);
  const to = Math.min(input.vocals16k.length / PITCH_SAMPLE_RATE, Math.max(...all.map((note) => note.end)) + MARGIN);
  const stretch = input.vocals16k.subarray(Math.floor(from * PITCH_SAMPLE_RATE), Math.ceil(to * PITCH_SAMPLE_RATE));
  // Notes past the vocals' end: nothing sung to go by.
  if (stretch.length < MIN_PITCH_SAMPLES) return new Map();
  const local = pitchTrack(await engines.trackPitch(stretch), stretch);
  signal?.throwIfAborted();
  const track: PitchTrack = { times: local.times.map((t) => t + from), midi: local.midi };
  const songMidi = input.songMidi.some((m) => !Number.isNaN(m)) ? input.songMidi : track.midi;
  const tuning = tuningOffset(songMidi);
  const scale = estimateScale(songMidi, tuning);

  // GAME on each line with asked-for notes, its notes' starts as known boundaries.
  const requests = lines.map((line) => {
    if (!line.some((note) => input.notes.has(note.id))) return null;
    const spans: SyllableSpan[] = line.map((note) => ({ text: "", start: note.start, end: note.end, score: 1 }));
    return gameRequest(spans, input.vocals44k.length, GAME_SAMPLE_RATE);
  });
  const wanted = requests.flatMap((request) => (request ? [request] : []));
  const byRequest = wanted.length
    ? splitGameNotes(
        await engines.transcribeNotes(
          input.vocals44k,
          wanted.map(({ from: a, to: b, known }) => ({ from: a, to: b, known })),
          gameLanguage(input.language),
          onProgress,
        ),
      )
    : [];
  signal?.throwIfAborted();

  // Each line as notes on the grid: the asked-for ones with GAME's (or the sung) pitch, the others as they are.
  let next = 0;
  const found = new Set<number>();
  const noteLines: Note[][] = [];
  const traces: TraceEntry[][] = [];
  lines.forEach((line, l) => {
    const request = requests[l];
    const raw = request ? byRequest[next++]! : [];
    const notes: Note[] = [];
    const trace: TraceEntry[] = [];
    line.forEach((note, i) => {
      let midi = note.pitch;
      /** What was sung (MIDI, in the song's tuning): the corrector compares the note with it, as in the pipeline. */
      let heard = midi;
      let parts = 0;
      if (input.notes.has(note.id)) {
        const mine = request
          ? raw.filter((n) => {
              const middle = request.a + (n.start + n.end) / 2;
              return n.voiced && note.start - 0.02 <= middle && middle < note.end;
            })
          : [];
        const longest = mine.reduce<(typeof mine)[number] | null>(
          (best, n) => (!best || n.end - n.start > best.end - best.start ? n : best),
          null,
        );
        // GAME's pitch is snapped as it is (as in the pipeline); the sung median is in the song's tuning, notes
        // aren't (as in the octave fix).
        const median = longest ? Number.NaN : sungMedian(track, note.start, note.end);
        const sung = longest?.midi ?? median - tuning;
        if (!Number.isNaN(sung)) {
          midi = snap(sung, scale, 0.35);
          heard = longest?.midi ?? median;
          parts = 1;
          found.add(note.id);
        }
      }
      const start = toBeat(input.grid, note.start);
      notes.push({
        type: note.type,
        start,
        length: Math.max(1, toBeat(input.grid, note.end) - start),
        pitch: midi - 60,
        text: "",
      });
      trace.push({ start: note.start, end: note.end, raw: heard, syl: i, part: 0, parts });
    });
    noteLines.push(notes);
    traces.push(trace);
  });

  // The learned corrector, the lines' other notes as context; only the asked-for notes shift.
  const features = noteLines.flatMap((notes, l) => noteFeatures(notes, traces[l]!, track, tuning, scale));
  const shifts = features.length ? await engines.predictPitchShifts(featureMatrix(features)) : new Float32Array();
  signal?.throwIfAborted();
  const classes = PITCH_SHIFTS.length;
  let at = 0;
  lines.forEach((line, l) => {
    line.forEach((note, i) => {
      if (found.has(note.id))
        applyPitchShifts([noteLines[l]![i]!], shifts.subarray((at + i) * classes, (at + i + 1) * classes));
    });
    at += line.length;
  });

  // The octave fix over the lines (the notes it may move are only kept for the asked-for ones).
  // `all` and the lines' notes are in the same order.
  const sungNotes = noteLines
    .flat()
    .flatMap((note, i) =>
      note.type === "normal" || note.type === "golden"
        ? [{ start: all[i]!.start, end: all[i]!.end, midi: note.pitch + 60 }]
        : [],
    );
  const ratios = await engines.harmonicRatios(input.vocals44k, sungNotes);
  signal?.throwIfAborted();
  fixOctaves(noteLines, input.grid, track, tuning, harmonicPairs(ratios));

  const result = new Map<number, number>();
  lines.forEach((line, l) => {
    line.forEach((note, i) => {
      if (found.has(note.id)) result.set(note.id, noteLines[l]![i]!.pitch + 60);
    });
  });
  return result;
}
