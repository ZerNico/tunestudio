import { describe, expect, it } from "vitest";

import { autoPitch, type AutoPitchEngines, type PitchNote } from "./auto-pitch";

/** Six seconds of (silent) vocals at both rates. */
const vocals16k = new Float32Array(6 * 16_000);
const vocals44k = new Float32Array(6 * 44_100);
/** The song sung over C major, in tune. */
const songMidi = Float32Array.from({ length: 2100 }, (_, i) => [60, 62, 64, 65, 67, 69, 71][i % 7]!);

const note = (id: number, start: number, pitch = 60): PitchNote => ({
  id,
  start,
  end: start + 0.4,
  pitch,
  type: "normal",
});

/** One line: "1" (1 s) and "2" (1.5 s) to be pitched, "3" (2 s) as context. */
const line = [note(1, 1), note(2, 1.5), note(3, 2, 64)];

/**
 * FCPE hears A4 throughout; GAME hears D4 a little sharp in note 1, nothing in note 2 and F♯4 in note 3 (seconds
 * relative to the line's audio, which starts 0.2 s before its first note). `shift` is the corrector's answer for every
 * note (an index into -2..2).
 */
function engines(shift = 2): AutoPitchEngines & {
  requests: { from: number; to: number; known: number[] }[];
  features: Float32Array[];
} {
  const requests: { from: number; to: number; known: number[] }[] = [];
  const features: Float32Array[] = [];
  return {
    requests,
    features,
    trackPitch: async (samples) => new Float32Array(Math.floor(samples.length / 160) + 1).fill(440),
    transcribeNotes: async (_samples, asked) => {
      requests.push(...asked);
      return {
        counts: [3],
        starts: Float64Array.from([0.25, 0.75, 1.25]),
        ends: Float64Array.from([0.55, 1.05, 1.55]),
        voiced: Uint8Array.from([1, 0, 1]),
        midi: Float64Array.from([62.2, 50, 66]),
      };
    },
    harmonicRatios: async (_samples, notes) => new Float64Array(notes.length * 2),
    predictPitchShifts: async (matrix) => {
      features.push(matrix);
      return Float32Array.from({ length: (matrix.length / 24) * 5 }, (_, i) => (i % 5 === shift ? 1 : 0));
    },
  };
}

const input = (notes: number[]) => ({
  vocals16k,
  vocals44k,
  lines: [line],
  notes: new Set(notes),
  grid: { bpm: 480, gap: 0 },
  songMidi,
  language: { name: "english", code: "eng" },
});

describe("auto pitch", () => {
  it("takes GAME's pitch with the notes as known boundaries, the sung pitch where GAME found none", async () => {
    const run = engines();
    const pitches = await autoPitch(input([1, 2]), run);
    expect(pitches).toEqual(
      new Map([
        [1, 62],
        [2, 69],
      ]),
    );
    // One GAME run over the line, its notes' starts as the known boundaries (0.8 s to 2.6 s).
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]!.known.map((d) => Math.round(d * 100) / 100)).toEqual([0.2, 0.5, 0.5, 0.6]);
  });

  it("lets the corrector shift only the asked-for notes", async () => {
    const pitches = await autoPitch(input([1, 2]), engines(3));
    expect(pitches).toEqual(
      new Map([
        [1, 63],
        [2, 70],
      ]),
    );
  });

  it("finds nothing for notes that aren't there", async () => {
    expect(await autoPitch(input([99]), engines())).toEqual(new Map());
  });

  it("shows the corrector what GAME heard before it was snapped, as the chart making does", async () => {
    const run = engines();
    await autoPitch(input([1]), run);
    // Note 1's row: GAME heard 62.2, the note is 62.
    expect(run.features[0]![0]).toBeCloseTo(0.2, 5);
  });

  it("listens only to the lines with asked-for notes, the others are context", async () => {
    const run = engines();
    const later = [note(4, 4), note(5, 4.5)];
    await autoPitch({ ...input([1]), lines: [line, later] }, run);
    expect(run.requests).toHaveLength(1);
    // Both lines go to the corrector.
    expect(run.features[0]!.length / 24).toBe(5);
  });

  it("finds nothing past the vocals' end", async () => {
    const past = [note(10, 8), note(11, 8.5)];
    expect(await autoPitch({ ...input([10, 11]), lines: [past] }, engines())).toEqual(new Map());
  });

  it("stops between its stages when asked to", async () => {
    const controller = new AbortController();
    const run = engines();
    const trackPitch = run.trackPitch;
    run.trackPitch = async (samples) => {
      controller.abort();
      return trackPitch(samples);
    };
    await expect(autoPitch(input([1]), run, () => {}, controller.signal)).rejects.toThrow();
    expect(run.requests).toHaveLength(0);
  });
});
