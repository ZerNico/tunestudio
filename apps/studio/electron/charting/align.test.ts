import { describe, expect, it } from "vitest";

import {
  alignerTargets,
  getSpans,
  isWord,
  mergeRepeats,
  pullInEdges,
  snapToVoice,
  timingsFromPath,
  VOCAB,
  wordParts,
  type WordTiming,
} from "./align";
import { callsOf, goldenSongs, loadGolden } from "./goldens";

/** A recorded WordTiming without its type tag. */
function plain(w: WordTiming & { $type?: string }): WordTiming {
  return { text: w.text, start: w.start, end: w.end, score: w.score, chars: w.chars };
}

describe("align", () => {
  it("splits vocalisations and finds singable words", () => {
    expect(wordParts("oh–oh~-oh")).toEqual(["oh", "oh", "oh"]);
    expect(isWord("...")).toBe(false);
    expect(isWord("Ü")).toBe(true);
  });

  it("makes targets with a <star> before each word", () => {
    expect(alignerTargets(["Hi", "!!", "yo"], "eng")).toEqual({
      tokens: ["<star>", "h i", "<star>", "", "<star>", "y o"],
      ids: Int32Array.from([31, VOCAB.h!, VOCAB.i!, 31, 31, VOCAB.y!, VOCAB.o!]),
    });
  });

  it("pads spans with half the blanks around them", () => {
    const path = [31, 0, 0, 18, 5, 0, 0, 0, 0, 31];
    const segments = mergeRepeats(path);
    expect(
      getSpans(["<star>", "h i", "<star>"], segments).map((span) => span.map((s) => [s.label, s.start, s.end])),
    ).toEqual([
      [
        ["<star>", 0, 0],
        ["<blank>", 0, 1],
      ],
      [
        ["<blank>", 1, 3],
        ["h", 3, 3],
        ["i", 4, 4],
        ["<blank>", 4, 6],
      ],
      [
        ["<blank>", 6, 9],
        ["<star>", 9, 9],
      ],
    ]);
  });
});

describe.skipIf(!goldenSongs().length)("align against the PoC", () => {
  for (const song of goldenSongs()) {
    it(song, () => {
      const golden = loadGolden(song);
      const aligned = callsOf(golden, "autotuner.align._align_tokens");
      const alignments = callsOf(golden, "ctc_forced_aligner.get_alignments");
      expect(aligned.length).toBe(alignments.length);
      aligned.forEach((call, k) => {
        const [, stride, words, language] = call.args as [unknown, number, string[], string];
        const [segments, scores] = alignments[k]!.result as [
          { label: string; start: number; end: number }[],
          Float32Array,
        ];
        const path = segments.flatMap((s) => Array.from({ length: s.end - s.start + 1 }, () => VOCAB[s.label]!));
        expect(alignerTargets(words, language).tokens).toEqual(alignments[k]!.args[1]);
        const got = timingsFromPath(path, scores, words, language, stride, (call.kwargs as { offset: number }).offset);
        expect(got).toEqual((call.result as WordTiming[]).map(plain));
      });

      for (const call of callsOf(golden, "autotuner.align.pull_in_edges")) {
        const words = (call.args[0] as WordTiming[]).map(plain);
        pullInEdges(words);
        expect(words).toEqual((call.args_after![0] as WordTiming[]).map(plain));
      }
      for (const call of callsOf(golden, "autotuner.align.snap_to_voice")) {
        const [before, midi, rms, hop] = call.args as [WordTiming[], Float32Array, Float32Array, number];
        const words = before.map(plain);
        snapToVoice(words, midi, rms, hop);
        expect(words).toEqual((call.args_after![0] as WordTiming[]).map(plain));
      }
    });
  }
});
