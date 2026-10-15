import { describe, expect, it } from "vitest";

import { VOCAB, type WordTiming } from "./align";
import { alignStage, AlignFailed, type ForcedAlign, type LyricLine } from "./align-stage";
import { callsOf, goldenSongs, loadGolden } from "./goldens";

const untagged = <T extends object>(x: T & { $type?: string }): T => {
  const { $type: _, ...rest } = x;
  return rest as T;
};

describe("align stage", () => {
  it("falls back to aligning line by line when the whole song can't be aligned", async () => {
    const calls: [number, number][] = [];
    const forcedAlign: ForcedAlign = async (from, to, ids) => {
      calls.push([from, to]);
      if (from === 0 && to === 500) throw new AlignFailed("too long");
      // Every frame on the star, then the word's letters, one frame each.
      const path = [...ids].flatMap((id) => [id]);
      return {
        path: [...path, ...Array.from({ length: to - from - path.length }, () => 0)],
        scores: new Float32Array(to - from),
      };
    };
    const lines: LyricLine[] = [
      { text: "la", start: 1, end: 2 },
      { text: "da", start: 5, end: 6 },
    ];
    const { aligned } = await alignStage({
      lines,
      language: "eng",
      frames: 500,
      forcedAlign,
      midi: new Float32Array(1000),
      rms: new Float32Array(1000),
      songEnd: 9.99,
    });
    expect(calls).toEqual(
      [
        [0, 500],
        [0, 301],
        [200, 550],
      ].map(([a, b]) => [a, Math.min(b!, 500)]),
    );
    expect(aligned.map((ws) => ws.map((w) => w.text))).toEqual([["la"], ["da"]]);
  });
});

describe.skipIf(!goldenSongs().length)("align stage against the PoC", () => {
  for (const song of goldenSongs()) {
    it(song, async () => {
      const golden = loadGolden(song);
      const [stage] = callsOf(golden, "autotuner.pipeline._align_stage");
      const recorded = callsOf(golden, "ctc_forced_aligner.get_alignments");
      const [, rawLines, language, , track] = stage!.args as [
        string,
        (LyricLine & { alt_starts: number[]; $type: string })[],
        string,
        string,
        { times: Float64Array; midi: Float32Array; rms: Float32Array },
      ];
      const [firstAlign] = recorded;
      const frames = (firstAlign!.args[0] as Float32Array).length / 32;
      let next = 0;
      const forcedAlign: ForcedAlign = async (_from, _to, ids) => {
        const call = recorded[next++]!;
        const tokens = call.args[1] as string[];
        // The same targets the PoC aligned, in the same order.
        expect(ids).toEqual(
          Int32Array.from(
            tokens.flatMap((t) =>
              t === "<star>"
                ? [VOCAB["<star>"]!]
                : t
                    .split(" ")
                    .filter((c) => c in VOCAB)
                    .map((c) => VOCAB[c]!),
            ),
          ),
        );
        const [segments, scores] = call.result as [{ label: string; start: number; end: number }[], Float32Array];
        return {
          path: segments.flatMap((s) => Array.from({ length: s.end - s.start + 1 }, () => VOCAB[s.label]!)),
          scores,
        };
      };
      const lines = rawLines.map((l): LyricLine => ({
        text: l.text,
        start: l.start,
        end: l.end,
        altStarts: l.alt_starts,
      }));
      const { aligned } = await alignStage({
        lines,
        language: language.toLowerCase() === "english" ? "eng" : "deu",
        frames,
        forcedAlign,
        midi: track.midi,
        rms: track.rms,
        songEnd: track.times.at(-1)!,
      });
      expect(next).toBe(recorded.length);
      expect(aligned).toEqual((stage!.result as (WordTiming & { $type: string })[][]).map((ws) => ws.map(untagged)));
    });
  }
});
