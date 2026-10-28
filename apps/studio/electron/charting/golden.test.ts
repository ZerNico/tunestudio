import { describe, expect, it } from "vitest";

import {
  FEATURES,
  features,
  goldenProbabilities,
  lyricsKey,
  markGolden,
  pick,
  PICK,
  structure,
  type LoudTrack,
  type PickOptions,
  type Structure,
} from "./golden";
import { callsOf, goldenSongs, loadGolden } from "./goldens";
import type { Grid } from "./grid";
import type { Note } from "./notes";

const GRID: Grid = { bpm: 300, gap: 0 }; // a beat is 50 ms
const col = (X: Float32Array, k: number, name: (typeof FEATURES)[number]) =>
  X[k * FEATURES.length + FEATURES.indexOf(name)];

const note = (start: number, length: number, pitch: number, text: string): Note => ({
  type: "normal",
  start,
  length,
  pitch,
  text,
});

/**
 * 20 lines: three short notes, a melisma "hold ~ ~" peaking in its middle, a rest, and a long last note. A pitch track
 * singing every note on pitch, the long ones louder.
 */
function song(): { lines: Note[][]; track: LoudTrack } {
  const lines = Array.from({ length: 20 }, (_, li) => {
    const s = li * 100;
    return [
      note(s, 4, 0, "one "),
      note(s + 5, 4, 2, "two "),
      note(s + 10, 4, 1, "three "),
      note(s + 15, 4, 5, "hold"),
      note(s + 19, 4, 9, "~"),
      note(s + 23, 4, 4, "~ "),
      note(s + 40, 20, 3, "end "),
    ];
  });
  const n = 20 * 100 * 5 + 200;
  const midi = new Float32Array(n).fill(Number.NaN);
  const rms = new Float32Array(n).fill(-60);
  for (const line of lines)
    for (const x of line) {
      const a = Math.trunc(x.start * 0.05 * 100);
      const b = Math.trunc((x.start + x.length) * 0.05 * 100);
      midi.fill(x.pitch + 60, a, b);
      rms.fill(x.length > 10 ? -20 : -30, a, b);
    }
  return { lines, track: { times: Float64Array.from({ length: n }, (_, i) => i * 0.01), midi, rms } };
}

/** golden.onnx's output (per note: normal, golden) for these probabilities of being golden. */
const output = (proba: ArrayLike<number>) =>
  Float32Array.from({ length: proba.length * 2 }, (_, i) => {
    const p = proba[Math.floor(i / 2)]!;
    return i % 2 ? p : 1 - p;
  });

/** `structure` of n notes a second apart, one melisma and line each unless given. */
function spaced(n: number, melisma?: number[], line?: number[], text?: number[]): Structure {
  const lines = line ?? Array.from({ length: n }, (_, k) => k);
  return {
    start: Float64Array.from({ length: n }, (_, k) => k),
    end: Float64Array.from({ length: n }, (_, k) => k + 1),
    midi: new Float64Array(n),
    beat: new Float64Array(n),
    line: Int32Array.from(lines),
    phrase: Int32Array.from(lines),
    melisma: Int32Array.from(melisma ?? lines),
    tilde: new Uint8Array(n),
    wordEnd: new Uint8Array(n),
    text: Int32Array.from(text ?? lines),
  };
}

const filled = (n: number, value: number, set: Record<number, number> = {}) => {
  const out = new Float64Array(n).fill(value);
  for (const [k, v] of Object.entries(set)) out[Number(k)] = v;
  return out;
};

describe("golden notes", () => {
  it("sees lines, phrases and melismas", () => {
    const { lines, track } = song();
    const X = features(lines, GRID, track, 0);
    expect(X.length).toBe(140 * FEATURES.length);
    expect(X.every(Number.isFinite)).toBe(true);
    // The 0.85 s rest before "end" splits the line into two phrases, the line is still one.
    expect([
      col(X, 5, "phrase_last"),
      col(X, 6, "phrase_first"),
      col(X, 5, "line_last"),
      col(X, 6, "line_last"),
    ]).toEqual([1, 1, 0, 1]);
    expect([
      col(X, 4, "phrase_peak"),
      col(X, 0, "below_phrase_peak"),
      col(X, 3, "mel_size"),
      col(X, 4, "mel_range"),
    ]).toEqual([1, 9, 3, 5]);
    expect(col(X, 6, "sec")).toBeCloseTo(1);
    expect(col(X, 6, "loud")).toBeCloseTo(10);
    expect([col(X, 3, "word_end"), col(X, 5, "word_end"), col(X, 0, "word_end")]).toEqual([0, 1, 1]);
    const s = structure(lines, GRID);
    expect([s.melisma[3] === s.melisma[5], s.melisma[2] === s.melisma[3], s.phrase[6]! - s.phrase[5]!]).toEqual([
      true,
      false,
      1,
    ]);
  });

  it("works without a loudness track", () => {
    const { lines, track } = song();
    const X = features(lines, GRID, { times: track.times, midi: track.midi }, 0);
    expect(Array.from({ length: 140 }, (_, k) => col(X, k, "loud")).every((x) => x === 0)).toBe(true);
    expect(features([[]], GRID, track, 0)).toEqual(new Float32Array(0));
  });

  it("finds repeated lyrics", () => {
    const lines = [
      [note(0, 4, 0, "Wann "), note(5, 4, 0, "Mann?"), note(9, 4, 0, "~ ")],
      [note(20, 4, 0, "oh")],
      [note(40, 4, 0, "wann "), note(45, 8, 0, "Mann? ")],
      [note(60, 4, 0, "oh")],
    ];
    expect(lyricsKey(lines[0]!)).toBe("wannmann");
    // "oh" is too short to count as a repeat.
    expect(Array.from(structure(lines, GRID).text)).toEqual([0, 0, 0, 1, 0, 0, 3]);
  });

  it("picks the expected number", () => {
    const s = spaced(100);
    const proba = filled(100, 0.02, { 10: 0.9, 40: 0.8, 70: 0.7 }); // sum 4.36: four notes
    const picked = pick(proba, s, { ...PICK, start: "any", runs: null, spread: null });
    expect(picked).toHaveLength(4);
    expect(picked).toEqual(expect.arrayContaining([10, 40, 70]));
    expect(pick(proba, s, { ...PICK, scale: 0.5 })).toHaveLength(2);
    expect(pick(filled(100, 0.004), s, PICK)).toEqual([]); // nothing stands out: no golden notes
  });

  it("keeps melismas together from their syllable", () => {
    const s = spaced(
      100,
      Array.from({ length: 100 }, (_, k) => Math.floor(k / 4)),
    ); // 25 melismas "hold ~ ~ ~"
    const proba = filled(100, 0, { 20: 0.2, 21: 0.3, 22: 0.9, 23: 0.2 }); // sum 1.6: two notes
    // Two "~" without their syllable.
    expect(pick(proba, s, { ...PICK, start: "any", runs: null, spread: null })).toEqual([21, 22]);
    // Its first three notes have the best mean (0.47), the fourth would drop it to 0.4.
    expect(pick(proba, s, { ...PICK, runs: null })).toEqual([20, 21, 22]);
    expect(pick(proba, s, { ...PICK, runs: 0.8 })).toEqual([20, 21, 22, 23]);
    proba.set([0.9, 0.1, 0.1, 0.1], 60); // sum 2.8: three notes
    // 60 alone first (0.9), then the first melisma whole (0.4), not cut at the number.
    expect(pick(proba, s, PICK)).toEqual([20, 21, 22, 23, 60]);
  });

  it("takes a melisma along when it is likely enough", () => {
    const s = spaced(
      100,
      Array.from({ length: 100 }, (_, k) => Math.floor(k / 2)),
    );
    const proba = filled(100, 0, { 10: 0.9, 11: 0.9, 40: 0.85, 41: 0.1 }); // sum 2.75: three notes
    expect(pick(proba, s, { ...PICK, start: "any", runs: 1, spread: null })).toEqual([10, 11, 40]);
  });

  it("spreads over the song and caps repeated lines", () => {
    const proba = Float64Array.from({ length: 100 }, (_, k) => (k < 10 ? 0.9 : 0.01)); // 10 golden notes
    const picked = pick(proba, spaced(100), { ...PICK, start: "any", runs: null });
    expect([picked.length, picked.filter((k) => k < 10).length]).toEqual([10, 3]);

    const line = Array.from({ length: 100 }, (_, k) => Math.floor(k / 5));
    const s = spaced(
      100,
      undefined,
      line,
      line.map((li) => li % 4),
    ); // 4 lyrics, 5 times each
    const likely = new Float64Array(100);
    for (let li = 0; li < 20; li++) likely[li * 5 + 4] = li % 4 === 0 ? 0.9 : 0.5;
    const capped = pick(likely, s, { ...PICK, start: "any", runs: null, spread: null, repeat_cap: 2 });
    expect([new Set(capped.map((k) => line[k]!).filter((li) => li % 4 === 0)).size, capped.length]).toEqual([2, 12]);
  });

  it("marks by the model's probabilities", async () => {
    const { lines, track } = song();
    // line ends p 0.73, the rest 0.007: about 15 golden notes
    const predict = async (X: Float32Array) =>
      output(Array.from({ length: X.length / FEATURES.length }, (_, k) => (col(X, k, "line_last") ? 0.73 : 0.007)));
    lines[0]![0]!.type = "golden"; // replaced, not kept
    await markGolden(lines, GRID, track, 0, predict);
    const gold = lines.flat().filter((n) => n.type === "golden");
    expect(gold.length).toBeGreaterThanOrEqual(12);
    expect(gold.length).toBeLessThanOrEqual(16);
    expect(gold.every((n) => n.text === "end ")).toBe(true);
  });

  it("reads the golden column of the model's output", () => {
    expect(Array.from(goldenProbabilities(Float32Array.of(0.75, 0.25, 0.5, 0.5)))).toEqual([0.25, 0.5]);
  });
});

const untagged = <T extends object>(x: T & { $type?: string }): T => {
  const { $type: _, ...rest } = x;
  return rest as T;
};
const noteLines = (raw: unknown) => (raw as (Note & { $type: string })[][]).map((line) => line.map(untagged));
const numbers = (x: unknown) => Array.from(x as ArrayLike<number | bigint>, Number);

describe.skipIf(!goldenSongs().length)("golden notes against the PoC", () => {
  for (const song of goldenSongs()) {
    it(song, async () => {
      const golden = loadGolden(song);
      const [marked] = callsOf(golden, "autotuner.golden.mark");
      const [lines, grid, track, tuning] = marked!.args as [unknown, Grid & { $type: string }, LoudTrack, number];
      const g = untagged(grid);

      const [byFeatures] = callsOf(golden, "autotuner.golden.features");
      const want = Float32Array.from(numbers(byFeatures!.result));
      const X = features(noteLines(lines), g, track, tuning);
      let differ = 0;
      let worst = 0;
      X.forEach((x, i) => {
        if (x !== want[i]) differ++;
        worst = Math.max(worst, Math.abs(x - want[i]!) / Math.max(1, Math.abs(want[i]!)));
      });
      expect(worst).toBeLessThan(1e-6);

      console.info(`${song}: ${differ} of ${X.length} features differ (worst ${worst})`);

      const [byPick] = callsOf(golden, "autotuner.golden.pick");
      const s = structure(noteLines(lines), g);
      const [recorded] = callsOf(golden, "autotuner.golden.structure");
      const r = recorded!.result as Record<string, unknown>;
      expect([numbers(s.line), numbers(s.phrase), numbers(s.melisma), numbers(s.text)]).toEqual([
        numbers(r.line),
        numbers(r.phrase),
        numbers(r.melisma),
        numbers(r.text),
      ]);
      const options = { ...PICK, ...(byPick!.kwargs as Partial<PickOptions>) };
      expect(pick(Float64Array.from(numbers(byPick!.args[0])), s, options)).toEqual(numbers(byPick!.result));

      // golden.onnx itself runs in native.test.ts: here its recorded output.
      const [byProbabilities] = callsOf(golden, "autotuner.golden.probabilities");
      const after = noteLines(lines);
      await markGolden(after, g, track, tuning, async () => output(numbers(byProbabilities!.result)));
      expect(after).toEqual(noteLines(marked!.args_after![0]));
    });
  }
});
