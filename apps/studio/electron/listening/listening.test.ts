import { describe, expect, it } from "vitest";

import { lyricsLines } from "./listening";

describe("lyricsLines", () => {
  it("splits a verse Whisper wrote as one sentence into lines at its commas", () => {
    const text =
      "We're out walking by the sea, you hold the light, and so do I, I fold the paper while I'm dreaming of, you wouldn't find this on any other shore.";
    const lines = lyricsLines([{ start: 10, end: 24.4, text: ` ${text}`, confidence: 0.9 }]);
    expect(lines.map((line) => line.text)).toEqual([
      "We're out walking by the sea",
      "You hold the light, and so do I",
      "I fold the paper while I'm dreaming of",
      "You wouldn't find this on any other shore.",
    ]);
    // Times follow where each line starts in the sentence.
    expect(lines[0]).toMatchObject({ start: 10 });
    expect(lines.at(-1)).toMatchObject({ end: 24.4 });
    for (const [index, line] of lines.entries()) {
      expect(line.end).toBeGreaterThan(line.start);
      if (index > 0) expect(line.start).toBe(lines[index - 1]!.end);
    }
  });

  it("drops words Whisper made up from what the band left in the vocals", () => {
    // From a real song: the intro's leftovers came out as "and", stretched over seconds.
    expect(
      lyricsLines([
        { start: 8.1, end: 15.1, text: " and", confidence: 0.047 },
        { start: 15.1, end: 18.22, text: " and", confidence: 0.566 },
        { start: 118.62, end: 122.94, text: " Ooh, give you love", confidence: 0.659 },
        { start: 200, end: 203, text: " Yeah", confidence: 0.92 },
      ]).map((line) => line.text),
    ).toEqual(["Ooh, give you love", "Yeah"]);
  });

  it("keeps lyrics in every script", () => {
    const lines = ["君が好き", "Я тебя люблю", "أحبك", "我爱你", "Σ' αγαπώ"];
    expect(
      lyricsLines(lines.map((text, index) => ({ start: index * 3, end: index * 3 + 2, text, confidence: 0.9 }))).map(
        (line) => line.text,
      ),
    ).toEqual(lines);
  });

  it("keeps short lines as they are and drops what Whisper made up", () => {
    expect(
      lyricsLines([
        { start: 1, end: 3, text: " Never gonna give you up,  never gonna ", confidence: 0.9 },
        { start: 3, end: 5, text: "Thanks for watching!", confidence: 0.9 },
        { start: 5, end: 6, text: " ... ", confidence: 0.9 },
        { start: 6, end: 8, text: "Untertitel im Auftrag des ZDF", confidence: 0.9 },
      ]),
    ).toEqual([{ start: 1, end: 3, text: "Never gonna give you up, never gonna" }]);
  });
});
