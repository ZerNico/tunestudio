import { describe, expect, it } from "vitest";

import words from "./fixtures/syllables.json";
import { normalize, ruleSplit, syllabify } from "./syllables";

describe("syllabify", () => {
  it("splits like the PoC on words from the library's charts", () => {
    const differ = (words as [string, string, string[]][]).filter(
      ([word, language, expected]) => JSON.stringify(syllabify(word, language)) !== JSON.stringify(expected),
    );
    expect(differ.slice(0, 20)).toEqual([]);
    expect(words.length).toBeGreaterThan(10_000);
  });

  it("maps a learned split back onto the word's own casing and punctuation", () => {
    expect(syllabify("Forever,", "English")).toEqual(["For", "e", "ver,"]);
    expect(normalize("Don’t!")).toBe("don't");
  });

  it("splits unknown words by vowel groups and onsets", () => {
    expect(ruleSplit("blorptastic", "english")).toEqual(["blorp", "ta", "stic"]);
    // Other languages use the English rules.
    expect(ruleSplit("chanson", "french")).toEqual(ruleSplit("chanson", "english"));
  });
});
