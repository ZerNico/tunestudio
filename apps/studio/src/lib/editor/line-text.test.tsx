import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import type { EditorChart } from "~/lib/native/types";

import { createChartDocument } from "./document";
import { applyLineText, lineText, parseLineText, type Syllables, wordsToSplit } from "./line-text";
import { testNote as note, testSong } from "./test-chart";

/** Grid: 0.05 s steps; each note 0.3 s (6 steps) unless said. */
function chartOf(lyrics: string[], duration = 0.3): EditorChart {
  return {
    bpm: 300,
    gap: 1,
    song: testSong,
    singers: [
      {
        id: 1,
        index: 1,
        name: null,
        lines: [
          {
            id: 10,
            switchStart: null,
            switchEnd: null,
            notes: lyrics.map((lyric, i) => note(100 + i, 1 + i * 0.5, lyric, duration)),
          },
        ],
      },
    ],
  };
}

const LINE = ["Dei", "ne ", "Hand ", "zum ", "Grei", "fen ", "nah,", "~"];

function apply(chart: EditorChart, text: string, syllables?: Syllables) {
  const doc = createRoot(() => {
    const [selection, setSelection] = createSignal<number[]>([]);
    return createChartDocument<number[]>({
      chart,
      save: async () => {},
      onFailed: () => {},
      selection,
      setSelection,
    });
  });
  const before = doc.revision();
  const problem = doc.tryEdit("Edit line", (tx) => applyLineText(tx, chart, 10, text, syllables));
  const changed = doc.revision() !== before;
  flush();
  const notes = doc.chart().singers[0]!.lines[0]!.notes.toSorted((a, b) => a.start - b.start);
  return { problem, changed, lyrics: notes.map((item) => item.lyric), notes };
}

describe("a line's lyrics as text", () => {
  it("shows words with spaces and syllables with -, held notes as ~ and a hyphen escaped", () => {
    expect(lineText(LINE.map((lyric) => ({ lyric })))).toBe("Dei-ne Hand zum Grei-fen nah,-~");
    // A hyphen that is part of a syllable ("Ba-" sung on one note) shows escaped.
    expect(lineText(["Ba-", "by ", "go"].map((lyric) => ({ lyric })))).toBe("Ba\\--by go");
    expect(parseLineText("Ba\\-by go")).toEqual([
      { pieces: ["Ba-by"], text: "Ba-by" },
      { pieces: ["go"], text: "go" },
    ]);
    expect(wordsToSplit("Dei-ne Hand Hand")).toEqual(["Hand"]);
  });

  it("changes only the syllables that changed", () => {
    const { problem, lyrics } = apply(chartOf(LINE), "Dei-ne Hund zum Grei-fen nah,-~");
    expect(problem).toBeNull();
    expect(lyrics).toEqual(["Dei", "ne ", "Hund ", "zum ", "Grei", "fen ", "nah,", "~"]);
  });

  it("splits a word's notes for more syllables, and holds the rest for fewer", () => {
    const more = apply(chartOf(LINE), "Dei-ne Hand zu-sam-men Grei-fen nah,-~");
    expect(more.lyrics).toEqual(["Dei", "ne ", "Hand ", "zu", "sam", "men ", "Grei", "fen ", "nah,", "~"]);
    // The note "zum" was split into three (6 steps: 3, then 2 and 1 or the like), each on the grid.
    expect(more.notes.slice(3, 6).reduce((sum, item) => sum + item.duration, 0)).toBeCloseTo(0.3, 9);
    const fewer = apply(chartOf(LINE), "Dei-ne Hand zum Griff nah,-~");
    expect(fewer.lyrics).toEqual(["Dei", "ne ", "Hand ", "zum ", "Griff", "~ ", "nah,", "~"]);
  });

  it("splits a changed word typed whole into syllables, and keeps an unchanged one's", () => {
    const syllables: Syllables = (word) => (word === "Laufen" ? ["Lau", "fen"] : [word]);
    expect(apply(chartOf(LINE), "Dei-ne Hand zum Laufen nah,-~", syllables).lyrics).toEqual([
      "Dei",
      "ne ",
      "Hand ",
      "zum ",
      "Lau",
      "fen ",
      "nah,",
      "~",
    ]);
    expect(apply(chartOf(LINE), "Deine Hand zum Greifen nah,-~").lyrics).toEqual(LINE);
  });

  it("deletes the notes of a word that is gone", () => {
    const { lyrics, notes } = apply(chartOf(LINE), "Dei-ne Hand Grei-fen nah,-~");
    expect(lyrics).toEqual(["Dei", "ne ", "Hand ", "Grei", "fen ", "nah,", "~"]);
    expect(notes.map((item) => item.id)).not.toContain(103);
  });

  it("refuses words with no notes to go on, or syllables without room, changing nothing", () => {
    const added = apply(chartOf(LINE), "Dei-ne neue Hand zum Grei-fen nah,-~");
    expect(added.problem).toBe("“neue” has no notes. Draw them first.");
    expect(added.changed).toBe(false);
    const cramped = apply(chartOf(["la ", "la"], 0.05), "la-la-la la");
    expect(cramped.problem).toBe("“lalala” has more syllables than its notes have room for.");
    expect(cramped.changed).toBe(false);
    expect(apply(chartOf(LINE), "  ").problem).toBe("Type the line's lyrics, or delete its notes.");
  });

  it("keeps spaces before words when the line has them", () => {
    expect(apply(chartOf(["Hel", "lo", " world"]), "Hel-lo there").lyrics).toEqual(["Hel", "lo", " there"]);
  });
});

describe("a line's lyrics as text, with notes still without syllables", () => {
  it("puts typed words on drawn notes between words", () => {
    const { problem, lyrics } = apply(chartOf(["Hello ", "", "world"]), "Hello my world");
    expect(problem).toBeNull();
    expect(lyrics).toEqual(["Hello ", "my ", "world"]);
    expect(lineText(["Hello ", "", "world"].map((lyric) => ({ lyric })))).toBe("Hello  world");
  });

  it("leaves untouched words and empty notes as they are", () => {
    const { lyrics } = apply(chartOf(["Grei", "", "fen ", "nah"]), "Grei fen fern");
    expect(lyrics).toEqual(["Grei", "", "fen ", "fern"]);
  });

  it("keeps a syllable with a space in it whole, and the first note's leading space", () => {
    expect(lineText(["I'm a ", "girl"].map((lyric) => ({ lyric })))).toBe("I'm\\ a girl");
    expect(apply(chartOf(["I'm a ", "girl"]), "I'm\\ a boy").lyrics).toEqual(["I'm a ", "boy"]);
    expect(apply(chartOf([" Hel", "lo", " world"]), "Hel-lo there").lyrics).toEqual([" Hel", "lo", " there"]);
  });

  it("says which words have no room, as one phrase", () => {
    expect(apply(chartOf(["la"], 0.05), "la-la la-la").problem).toBe(
      "“lala lala” has more syllables than its notes have room for.",
    );
  });
});

describe("a line's lyrics as text, words moved or gone", () => {
  it("gives the line's notes to words moved within it, in order", () => {
    expect(apply(chartOf(["and ", "the ", "sea"]), "the sea and").lyrics).toEqual(["the ", "sea ", "and"]);
  });

  it("keeps a drawn note without a syllable when only the word beside it changes", () => {
    expect(apply(chartOf(["Hello ", "", "world"]), "Hi world").lyrics).toEqual(["Hi ", "", "world"]);
  });

  it("keeps the line's ends as they were when the first or last word goes", () => {
    expect(apply(chartOf(["Grei", "fen ", "nah"]), "Grei-fen").lyrics).toEqual(["Grei", "fen"]);
    expect(apply(chartOf(["Hel", "lo", " big", " world"]), "big world").lyrics).toEqual(["big", " world"]);
  });

  it("refuses held notes alone", () => {
    expect(apply(chartOf(LINE), "~ ~").problem).toBe("Type the line's lyrics, or delete its notes.");
  });
});
