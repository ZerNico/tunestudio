import { describe, expect, it } from "vitest";

import { codaOnHold, keepNotesApart } from "./charter-style";
import type { Note } from "./notes";

const n = (start: number, length: number, text: string): Note => ({ type: "normal", start, length, pitch: 0, text });
const texts = (lines: Note[][]) => lines.map((line) => line.map((note) => note.text));

describe("keepNotesApart", () => {
  it("leaves a beat between notes, as usdb_syncer would", () => {
    const lines = [[n(1160, 4, "mit"), n(1164, 6, "~ ")], [n(1170, 4, "uns ")]];
    keepNotesApart(lines);
    expect(lines.flat().map((note) => note.length)).toEqual([3, 5, 4]);
  });

  it("keeps a one-beat note", () => {
    const lines = [[n(10, 1, "a"), n(11, 2, "b ")]];
    keepNotesApart(lines);
    expect(lines[0]!.map((note) => note.length)).toEqual([1, 2]);
  });
});

describe("codaOnHold", () => {
  it("puts a held German syllable's closing consonants on its last held note", () => {
    const lines = [
      [n(400, 6, "Hand,"), n(408, 4, "~ "), n(414, 5, "die ")],
      [n(1392, 6, "Nein"), n(1398, 14, "~ ")],
      [n(648, 4, "Ge"), n(654, 6, "fühl"), n(663, 5, "~ "), n(672, 5, "o")],
    ];
    codaOnHold(lines, "german");
    expect(texts(lines)).toEqual([
      ["Ha", "~nd, ", "die "],
      ["Nei", "~n "],
      ["Ge", "fü", "~hl ", "o"],
    ]);
  });

  it("moves them past every held note, onto the last", () => {
    const lines = [[n(0, 4, "mir"), n(5, 4, "~"), n(10, 4, "~ ")]];
    codaOnHold(lines, "german");
    expect(texts(lines)).toEqual([["mi", "~", "~r "]]);
  });

  it("leaves a syllable that ends in its vowel, and a note that isn't held", () => {
    const lines = [[n(0, 4, "lei"), n(5, 4, "~"), n(10, 4, "ne "), n(15, 4, "Herz, ")]];
    codaOnHold(lines, "german");
    expect(texts(lines)).toEqual([["lei", "~", "ne ", "Herz, "]]);
  });

  it("keeps punctuation and apostrophes after the consonants", () => {
    const lines = [
      [n(0, 4, "Konnt’"), n(5, 4, "~ ")],
      [n(20, 4, "Herz!"), n(25, 4, "~")],
    ];
    codaOnHold(lines, "german");
    expect(texts(lines)).toEqual([
      ["Ko", "~nnt’ "],
      ["He", "~rz!"],
    ]);
  });

  it("leaves English as it is: its spelling doesn't say where the vowel ends", () => {
    const lines = [[n(0, 4, "smile"), n(5, 4, "~ ")]];
    codaOnHold(lines, "english");
    expect(texts(lines)).toEqual([["smile", "~ "]]);
  });
});
