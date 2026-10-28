import { describe, expect, it } from "vitest";

import { callsOf, goldenSongs, loadGolden } from "./goldens";
import type { Grid } from "./grid";
import type { Note } from "./notes";
import type { PitchTrack } from "./refiners";
import { bpmHeader, finishLines, fixed3, fixOctaves, gapHeader, splitLines, type HarmonicRatios } from "./song";

const untagged = <T extends object>(x: T & { $type?: string }): T => {
  const { $type: _, ...rest } = x;
  return rest as T;
};
const lines = (raw: unknown) => (raw as (Note & { $type: string })[][]).map((line) => line.map(untagged));

describe("song", () => {
  it("writes the headers like the PoC", () => {
    expect([bpmHeader(420.004), bpmHeader(300), bpmHeader(250.5), fixed3(0.0625), gapHeader(4.9476983)]).toEqual([
      "420.004",
      "300",
      "250.5",
      "0.062",
      4948,
    ]);
  });

  it("merges a held '~' into its note and keeps notes apart", () => {
    const n = (start: number, length: number, pitch: number, text: string): Note => ({
      type: "normal",
      start,
      length,
      pitch,
      text,
    });
    const { lines: done, breaks } = finishLines([[n(0, 4, 0, "la"), n(4, 4, 0, "~ ")], [n(20, 4, 2, "da ")]], {
      bpm: 300,
      gap: 0,
    });
    expect(done).toEqual([[n(0, 8, 0, "la ")], [n(20, 4, 2, "da ")]]);
    expect(breaks).toEqual([13]);
  });
});

describe.skipIf(!goldenSongs().length)("song against the PoC", () => {
  for (const song of goldenSongs()) {
    it(song, () => {
      const golden = loadGolden(song);
      const [octaves] = callsOf(golden, "autotuner.chart.fix_octaves");
      const ratios = callsOf(golden, "autotuner.chart._harmonics").map(
        (c) => c.result as [number, number] | null,
      ) as HarmonicRatios;
      const [before, grid, track, tuning] = octaves!.args as [unknown, Grid & { $type: string }, PitchTrack, number];
      const fixed = lines(before);
      fixOctaves(fixed, untagged(grid), track, tuning, ratios);
      expect(fixed).toEqual(lines(octaves!.args_after![0]));

      const [split] = callsOf(golden, "autotuner.chart.split_lines");
      const splitGrid = untagged(split!.args[1] as Grid & { $type: string });
      expect(splitLines(lines(split!.args[0]), splitGrid)).toEqual(lines(split!.result));

      const [built] = callsOf(golden, "autotuner.chart.build_song");
      const result = built!.result as { voices: unknown[]; breaks: Record<string, number> };
      const { lines: done, breaks } = finishLines(
        lines(built!.args[0]),
        untagged(built!.args[1] as Grid & { $type: string }),
      );
      expect(done).toEqual(lines(result.voices[0]));
      expect(breaks).toEqual(Object.values(result.breaks));
    });
  }
});
