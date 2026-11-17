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
  });

  it("splits words no table knows by their language's vowels, vowel groups and onsets", () => {
    expect(ruleSplit("corazón", "Spanish")).toEqual(["co", "ra", "zón"]);
    expect(ruleSplit("silencio", "Spanish")).toEqual(["si", "len", "cio"]);
    expect(ruleSplit("ayer", "Spanish")).toEqual(["a", "yer"]);
    expect(ruleSplit("minha", "Portuguese (Brazil)")).toEqual(["mi", "nha"]);
    // A final "ia" is two syllables unless an accent mark elsewhere takes the stress.
    expect(ruleSplit("dia", "Portuguese")).toEqual(["di", "a"]);
    expect(ruleSplit("memória", "Portuguese")).toEqual(["me", "mó", "ria"]);
    expect(ruleSplit("danse", "French")).toEqual(["danse"]);
    expect(ruleSplit("allez", "French")).toEqual(["a", "llez"]);
    expect(ruleSplit("niin", "Finnish")).toEqual(["niin"]);
    expect(ruleSplit("jibun", "Japanese (romanized)")).toEqual(["ji", "bu", "n"]);
    expect(ruleSplit("neomu", "Korean (romanized)")).toEqual(["neo", "mu"]);
    // Romanized K-pop and J-pop borrow English words.
    expect(syllabify("lonely", "Korean (romanized)")).toEqual(syllabify("lonely", "English"));
  });

  it("splits words the way charters of the language do where a table knows them", () => {
    // The rule splits "a-llez"; French charters write "al-lez".
    expect(syllabify("allez", "French")).toEqual(["al", "lez"]);
    expect(syllabify("Allez,", "French")).toEqual(["Al", "lez,"]);
  });

  it("gives Chinese characters, Hangul blocks and kana morae a syllable each", () => {
    expect(syllabify("我爱你", "Chinese")).toEqual(["我", "爱", "你"]);
    expect(syllabify("사랑해", "Korean")).toEqual(["사", "랑", "해"]);
    expect(syllabify("「ちょっと」", "Japanese")).toEqual(["「ちょっ", "と」"]);
  });

  it("splits Cyrillic and Greek by their vowels", () => {
    expect(syllabify("любовь", "Russian")).toEqual(["лю", "бовь"]);
    expect(syllabify("αγάπη", "Greek")).toEqual(["α", "γά", "πη"]);
  });

  it("takes words and languages named like Object's own properties as any other", () => {
    expect(syllabify("constructor", "english")).toEqual(ruleSplit("constructor", "english"));
    expect(syllabify("__proto__", "german").join("")).toBe("__proto__");
    expect(syllabify("hello", "constructor")).toEqual(ruleSplit("hello", "klingon"));
  });
});
