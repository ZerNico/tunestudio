import { describe, expect, it } from "vitest";

import type { WordTiming } from "./align";
import { callsOf, goldenSongs, loadGolden } from "./goldens";
import type { Grid } from "./grid";
import {
  gameRequest,
  notesFromGame,
  syllableSpans,
  type GameNote,
  type Note,
  type SyllableSpan,
  type TraceEntry,
} from "./notes";

/** Drop the recorder's type tags. */
const untagged = <T extends object>(x: T & { $type?: string }): T => {
  const { $type: _, ...rest } = x;
  return rest as T;
};

describe("notes", () => {
  it("splits a word's time between its syllables by its characters", () => {
    const word: WordTiming = {
      text: "hello",
      start: 1,
      end: 2,
      score: -0.5,
      chars: [
        [1, 1.1],
        [1.2, 1.3],
        [1.4, 1.5],
        [1.6, 1.7],
        [1.8, 1.9],
      ],
    };
    expect(syllableSpans([word], [["hel", "lo"]], 3)).toEqual([
      { text: "hel", start: 1, end: 1.6, score: -0.5 },
      { text: "lo ", start: 1.6, end: 3, score: -0.5 },
    ]);
  });
});

describe.skipIf(!goldenSongs().length)("notes against the PoC", () => {
  for (const song of goldenSongs()) {
    it(song, () => {
      const golden = loadGolden(song);
      for (const call of callsOf(golden, "autotuner.chart.syllable_spans")) {
        const [words, syllables, next] = call.args as [(WordTiming & { $type: string })[], string[][], number | null];
        expect(syllableSpans(words.map(untagged), syllables, next)).toEqual(
          (call.result as (SyllableSpan & { $type: string })[]).map(untagged),
        );
      }

      // Each line: notes_for_line_game, then its Game.extract and notefix's features (with the line's trace).
      const order = golden.calls.filter((c) =>
        ["autotuner.chart.notes_for_line_game", "Game.extract", "autotuner.notefix.apply"].includes(c.fn),
      );
      let lines = 0;
      for (let i = 0; i < order.length; i++) {
        const call = order[i]!;
        if (call.fn !== "autotuner.chart.notes_for_line_game") continue;
        const [spansTagged, wav, , gridTagged] = call.args as [
          (SyllableSpan & { $type: string })[],
          Float32Array,
          unknown,
          Grid & { $type: string },
        ];
        const kwargs = call.kwargs as { scale: number[]; samples: number; language: number; gap_units?: number };
        const spans = spansTagged.map(untagged);
        const grid = untagged(gridTagged);
        const request = gameRequest(spans, wav.length, 44_100);
        const extract = order[i + 1]?.fn === "Game.extract" ? order[i + 1]! : null;
        if (!request) {
          expect(call.result).toEqual([]);
          continue;
        }
        expect(extract).not.toBeNull();
        const [, chunk, known] = extract!.args as [unknown, Float32Array, number[]];
        expect([request.to - request.from, request.known]).toEqual([chunk.length, known]);
        const raw = (extract!.result as (GameNote & { $type: string })[]).map(untagged);
        const { notes, trace } = notesFromGame(spans, raw, request, grid, {
          scale: kwargs.scale,
          gapUnits: kwargs.gap_units,
        });
        expect(notes).toEqual((call.result as (Note & { $type: string })[]).map(untagged));
        const fix = order[i + 2];
        if (fix?.fn === "autotuner.notefix.apply") expect(trace).toEqual(fix.args[1] as TraceEntry[]);
        lines++;
      }
      expect(lines).toBeGreaterThan(10);
    });
  }
});
