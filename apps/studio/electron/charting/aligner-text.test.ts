import { describe, expect, it } from "vitest";

import { alignerTokens, normalizeText } from "./aligner-text";
import cases from "./fixtures/aligner-text.json";

describe("aligner text", () => {
  it("gives the PoC's tokens for lines of real lyric words and random strings", () => {
    const differ = (cases as [string, string, string[]][])
      .map(([text, language, tokens]) => ({ text, language, expected: tokens, got: alignerTokens(text, language) }))
      .filter(({ expected, got }) => JSON.stringify(expected) !== JSON.stringify(got));
    expect(differ.slice(0, 10)).toEqual([]);
    expect(cases.length).toBeGreaterThan(4000);
  });

  it("romanizes, drops punctuation and numbers, keeps apostrophes", () => {
    // Each word is normalized on its own: "(Sam" keeps its letters, "23:17)" loses everything.
    expect(alignerTokens("Grüße, Don’t 1999 (Sam 23:17) ça", "deu")).toEqual([
      "g r u e s s e",
      "d o n ' t",
      "",
      "s a m",
      "",
      "s a",
    ]);
    expect(normalizeText("Hello,World!")).toBe("hello world");
  });
});
