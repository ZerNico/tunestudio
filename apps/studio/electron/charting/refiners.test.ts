import { describe, expect, it } from "vitest";

import { callsOf, goldenSongs, loadGolden } from "./goldens";
import type { Note, TraceEntry } from "./notes";
import { applyEnds, applyPitchShifts, endFeatures, noteFeatures, type PitchTrack } from "./refiners";

const untagged = <T extends object>(x: T & { $type?: string }): T => {
  const { $type: _, ...rest } = x;
  return rest as T;
};

const note = (start: number, length: number, pitch: number, text: string): Note => ({
  type: "normal",
  start,
  length,
  pitch,
  text,
});

describe("refiners", () => {
  it("shifts a note only when a non-zero shift is likely enough", () => {
    const notes = [note(0, 4, 0, "a "), note(4, 4, 2, "b "), note(8, 4, 4, "c ")];
    applyPitchShifts(notes, Float32Array.from([0, 0.1, 0.3, 0.6, 0, 0.2, 0.2, 0.2, 0.2, 0.2, 0, 0, 1, 0, 0]));
    expect(notes.map((n) => n.pitch)).toEqual([1, 2, 4]);
  });

  it("moves note ends and keeps a gap before the next syllable", () => {
    const grid = { bpm: 300, gap: 0 };
    const notes = [note(0, 10, 0, "a"), note(12, 4, 0, "~"), note(20, 4, 0, "b ")];
    const trace = [0, 1, 2].map((i): TraceEntry => ({ start: i, end: i + 0.5, raw: 60, syl: i, part: 0, parts: 1 }));
    applyEnds(notes, trace, Float32Array.from([1, 1, -0.1]), grid);
    // 300 BPM: 0.05 s per beat. a would end at beat 30, but "~" starts at 12 (no gap before a "~").
    expect(notes.map((n) => n.length)).toEqual([12, 7, 28]);
    expect(endFeatures([[0], [0]], trace.slice(0, 2))).toEqual([
      [0, 1, 0, 0.5],
      [0, 0.5, 0.5, 1],
    ]);
  });
});

describe.skipIf(!goldenSongs().length)("refiners against the PoC", () => {
  for (const song of goldenSongs()) {
    it(song, () => {
      const golden = loadGolden(song);
      const calls = callsOf(golden, "autotuner.notefix.features");
      expect(calls.length).toBeGreaterThan(10);
      for (const call of calls) {
        const [notes, trace, track, tuning, scale] = call.args as [
          (Note & { $type: string })[],
          TraceEntry[],
          PitchTrack,
          number,
          number[] | null,
        ];
        expect(noteFeatures(notes.map(untagged), trace, track, tuning, scale)).toEqual(call.result);
      }
    });
  }
});
