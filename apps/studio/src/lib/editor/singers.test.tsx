import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import type { EditorChart } from "~/lib/native/types";

import { lineBreaks } from "./chart";
import { createChartDocument, type EditRecorder } from "./document";
import { addSinger, removeSinger, transferNotes } from "./singers";
import { testNote, testSong } from "./test-chart";

/** P1 sings three lines; P2 one line late in the song. Grid steps of 0.05 s. */
const duet = () => ({
  bpm: 300,
  gap: 0,
  song: testSong,
  singers: [
    {
      id: 1,
      index: 1 as const,
      name: "Anna",
      lines: [
        { id: 10, switchStart: 2.5, switchEnd: null, notes: [testNote(100, 1, "one "), testNote(101, 1.5, "two")] },
        { id: 11, switchStart: null, switchEnd: null, notes: [testNote(102, 3, "three "), testNote(103, 3.5, "four")] },
        { id: 12, switchStart: null, switchEnd: null, notes: [testNote(104, 5, "five")] },
      ],
    },
    {
      id: 2,
      index: 2 as const,
      name: "Ben",
      lines: [{ id: 20, switchStart: null, switchEnd: null, notes: [testNote(200, 8, "late")] }],
    },
  ],
});

function setup(chart: EditorChart) {
  return createRoot(() => {
    const doc = createChartDocument<number[]>({
      chart,
      save: async () => {},
      onFailed: () => {},
      selection: () => [],
      setSelection: () => {},
    });
    const run = <T,>(build: (tx: EditRecorder) => T): T => {
      let result!: T;
      doc.edit("Edit", (tx) => {
        result = build(tx);
      });
      flush();
      return result;
    };
    return { doc, run };
  });
}

const words = (chart: EditorChart, index: number) =>
  chart.singers
    .find((singer) => singer.index === index)!
    .lines.map((line) => line.notes.map((note) => note.lyric.trim()).join(" "));

describe("duet commands", () => {
  it("adds an empty second singer, and undoes it", () => {
    const solo = { ...duet(), singers: [duet().singers[0]!] };
    const { doc, run } = setup(solo);
    expect(run((tx) => addSinger(tx, doc.chart()))).not.toBeNull();
    expect(doc.chart().singers.map((singer) => [singer.index, singer.lines.length])).toEqual([
      [1, 3],
      [2, 0],
    ]);
    // A duet has no room for a third.
    expect(run((tx) => addSinger(tx, doc.chart()))).toBeNull();
    doc.undo();
    flush();
    expect(doc.chart()).toEqual(solo);
  });

  it("moves whole lines to the other singer with their breaks, and undoes exactly", () => {
    const source = duet();
    const { doc, run } = setup(source);
    const result = run((tx) => transferNotes(tx, doc.chart(), new Set([100, 101, 102, 103]), { copy: false }));
    expect(result).toHaveProperty("ids");
    const after = doc.chart();
    expect(words(after, 1)).toEqual(["five"]);
    expect(words(after, 2)).toEqual(["one two", "three four", "late"]);
    // The stored break between the moved lines came along.
    const moved = after.singers[1]!.lines[0]!;
    expect(lineBreaks(after).find((item) => item.lineId === moved.id)?.time).toBeCloseTo(2.5);
    const ben = after.singers[1]!.lines.flatMap((line) => line.notes);
    expect(ben.slice(0, 4).map((note) => [note.start, note.pitch])).toEqual([
      [1, 64],
      [1.5, 64],
      [3, 64],
      [3.5, 64],
    ]);
    doc.undo();
    flush();
    expect(doc.chart()).toEqual(source);
  });

  it("moves notes from the middle of a line, leaving the rest of it", () => {
    const { doc, run } = setup(duet());
    run((tx) => transferNotes(tx, doc.chart(), new Set([101]), { copy: false }));
    expect(words(doc.chart(), 1)).toEqual(["one", "three four", "five"]);
    expect(words(doc.chart(), 2)).toEqual(["two", "late"]);
  });

  it("gives notes moved from the middle of a line their own line there, unless they land inside one", () => {
    const source = duet();
    source.singers[0]!.lines[2]!.notes = [
      testNote(104, 5, "five "),
      testNote(105, 5.5, "six "),
      testNote(106, 6, "seven"),
    ];
    source.singers[1]!.lines[0]!.notes = [testNote(200, 0, "early")];
    const far = setup(source);
    far.run((tx) => transferNotes(tx, far.doc.chart(), new Set([105]), { copy: true }));
    expect(words(far.doc.chart(), 2)).toEqual(["early", "six"]);

    // Into a gap inside Ben's line: it joins that line.
    source.singers[1]!.lines[0]!.notes = [testNote(200, 4, "a "), testNote(201, 7, "b")];
    const inside = setup(source);
    inside.run((tx) => transferNotes(tx, inside.doc.chart(), new Set([105]), { copy: true }));
    expect(words(inside.doc.chart(), 2)).toEqual(["a six b"]);
  });

  it("moves lines around the other singer's, and keeps notes past the audio's end", () => {
    const source = duet();
    source.singers[1]!.lines[0]!.notes = [testNote(200, 3.2, "between")];
    source.singers[0]!.lines[2]!.notes = [testNote(104, 30, "late", 2)];
    const { doc, run } = setup(source);
    // Lines one and three around Ben's note: nothing overlaps, so it moves.
    expect(run((tx) => transferNotes(tx, doc.chart(), new Set([100, 101, 104]), { copy: false }))).toHaveProperty(
      "ids",
    );
    const ben = doc.chart().singers[1]!.lines.flatMap((line) => line.notes);
    expect(ben.map((note) => note.lyric)).toEqual(["one ", "two", "between", "late"]);
    const late = ben.at(-1)!;
    expect([late.start, late.duration]).toEqual([expect.closeTo(30, 9), expect.closeTo(2, 9)]);
  });

  it("keeps the breaks between notes picked from the middle of several lines", () => {
    const source = duet();
    source.singers[0]!.lines[0]!.notes = [testNote(100, 1, "a "), testNote(101, 1.5, "b "), testNote(105, 2, "c")];
    source.singers[0]!.lines[1]!.notes = [testNote(102, 3, "d "), testNote(103, 3.5, "e "), testNote(106, 4, "f")];
    source.singers[1]!.lines = [];
    const { doc, run } = setup(source);
    run((tx) => transferNotes(tx, doc.chart(), new Set([101, 103]), { copy: true }));
    expect(words(doc.chart(), 2)).toEqual(["b", "e"]);
  });

  it("merges a removed singer's notes without lines that interleave", () => {
    const source = duet();
    source.singers[0]!.lines = [
      { id: 10, switchStart: null, switchEnd: null, notes: [testNote(100, 0, "long", 10)] },
      { id: 11, switchStart: null, switchEnd: null, notes: [testNote(101, 12, "next", 1)] },
    ];
    source.singers[1]!.lines[0]!.notes = [testNote(200, 9, "over", 5)];
    const { doc, run } = setup(source);
    run((tx) => removeSinger(tx, doc.chart(), 2, { merge: true }));
    const lines = doc.chart().singers[0]!.lines.filter((line) => line.notes.length > 0);
    expect(
      lines
        .flatMap((line) => line.notes)
        .map((note) => note.lyric)
        .toSorted(),
    ).toEqual(["long", "next", "over"]);
    for (let i = 0; i + 1 < lines.length; i++) {
      const end = Math.max(...lines[i]!.notes.map((note) => note.start + note.duration));
      expect(end).toBeLessThanOrEqual(lines[i + 1]!.notes[0]!.start + 1e-9);
    }
    doc.undo();
    flush();
    expect(doc.chart()).toEqual(source);
  });

  it("copies notes for both to sing, leaving the original", () => {
    const { doc, run } = setup(duet());
    const result = run((tx) => transferNotes(tx, doc.chart(), new Set([104]), { copy: true }));
    expect(result).toMatchObject({ ids: [expect.any(Number)] });
    expect(words(doc.chart(), 1)).toEqual(["one two", "three four", "five"]);
    expect(words(doc.chart(), 2)).toEqual(["five", "late"]);
  });

  it("refuses where the other singer sings already, and notes of both singers", () => {
    const source = duet();
    source.singers[1]!.lines[0]!.notes = [testNote(200, 1.2, "over")];
    const { doc, run } = setup(source);
    expect(run((tx) => transferNotes(tx, doc.chart(), new Set([100]), { copy: false }))).toEqual({
      refused: "Ben already sings there.",
    });
    expect(run((tx) => transferNotes(tx, doc.chart(), new Set([100, 200]), { copy: true }))).toEqual({
      refused: "Select one singer's notes.",
    });
    expect(doc.chart()).toEqual(source);
    expect(doc.undoLabel()).toBeNull();
  });

  it("moves and copies off-grid notes at exactly their times, keeping whether they were edited", () => {
    const source = duet();
    // Off the 0.05 s grid; on it, the first would reach into Ben's note at 1.24.
    source.singers[0]!.lines[0]!.notes = [
      { ...testNote(100, 1.03, "one ", 0.2), edited: true },
      testNote(101, 1.5137, "two", 0.2711),
    ];
    source.singers[1]!.lines[0]!.notes = [testNote(200, 1.24, "close", 0.25)];
    const timing = (chart: EditorChart, index: number) =>
      chart.singers
        .find((singer) => singer.index === index)!
        .lines.flatMap((line) => line.notes)
        .map((note) => [note.lyric, note.start, note.duration, note.edited]);

    const copy = setup(source);
    expect(copy.run((tx) => transferNotes(tx, copy.doc.chart(), new Set([100, 101]), { copy: true }))).toHaveProperty(
      "ids",
    );
    expect(timing(copy.doc.chart(), 2)).toEqual([
      ["one ", 1.03, 0.2, true],
      ["close", 1.24, 0.25, false],
      ["two", 1.5137, 0.2711, false],
    ]);
    expect(timing(copy.doc.chart(), 1)).toEqual(timing(source, 1));

    const move = setup(source);
    move.run((tx) => transferNotes(tx, move.doc.chart(), new Set([100, 101]), { copy: false }));
    expect(timing(move.doc.chart(), 2)).toEqual(timing(copy.doc.chart(), 2));
    move.doc.undo();
    flush();
    expect(move.doc.chart()).toEqual(source);
  });

  it("merges a removed singer's off-grid notes at exactly their times, keeping whether they were edited", () => {
    const source = duet();
    source.singers[1]!.lines[0]!.notes = [
      testNote(200, 8.0123, "late ", 0.4567),
      { ...testNote(201, 8.6, "later", 0.3333), edited: true },
    ];
    const { doc, run } = setup(source);
    run((tx) => removeSinger(tx, doc.chart(), 2, { merge: true }));
    const notes = doc.chart().singers[0]!.lines.flatMap((line) => line.notes);
    expect(notes.slice(-2).map((note) => [note.lyric, note.start, note.duration, note.edited])).toEqual([
      ["late ", 8.0123, 0.4567, false],
      ["later", 8.6, 0.3333, true],
    ]);
    doc.undo();
    flush();
    expect(doc.chart()).toEqual(source);
  });

  it("keeps automatic breaks automatic when moving whole lines", () => {
    const { doc, run } = setup(duet());
    // Lines two and three: the break between them is automatic.
    run((tx) => transferNotes(tx, doc.chart(), new Set([102, 103, 104]), { copy: false }));
    const ben = doc.chart().singers[1]!.lines;
    expect(words(doc.chart(), 2)).toEqual(["three four", "five", "late"]);
    expect(ben.map((line) => [line.switchStart, line.switchEnd])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    const auto = lineBreaks(doc.chart()).filter((item) => item.singer === 2);
    expect(auto.map((item) => item.auto)).toEqual([true, true]);
  });

  it("keeps a two-point break with the lines it goes with, moved or copied", () => {
    for (const copy of [false, true]) {
      const source = duet();
      Object.assign(source.singers[0]!.lines[0]!, { switchEnd: 2.8 });
      Object.assign(source.singers[0]!.lines[1]!, { switchStart: 4.2, switchEnd: 4.6 });
      const { doc, run } = setup(source);
      run((tx) => transferNotes(tx, doc.chart(), new Set([100, 101, 102, 103, 104]), { copy }));
      expect(words(doc.chart(), 2)).toEqual(["one two", "three four", "five", "late"]);
      expect(doc.chart().singers[1]!.lines.map((line) => [line.switchStart, line.switchEnd])).toEqual([
        [2.5, 2.8],
        [4.2, 4.6],
        [null, null],
        [null, null],
      ]);
    }
  });

  it("keeps the stored break before a whole line moved after the other singer's", () => {
    const source = duet();
    Object.assign(source.singers[0]!.lines[0]!, { switchEnd: 2.8 });
    source.singers[1]!.lines[0]!.notes = [testNote(200, 0.2, "early")];
    const { doc, run } = setup(source);
    run((tx) => transferNotes(tx, doc.chart(), new Set([102, 103]), { copy: true }));
    expect(words(doc.chart(), 2)).toEqual(["early", "three four"]);
    expect(doc.chart().singers[1]!.lines[0]).toMatchObject({ switchStart: 2.5, switchEnd: 2.8 });
  });

  it("merges a removed singer's two-point break, dropping its end where a line of the other singer starts first", () => {
    const source = duet();
    source.singers[0]!.lines[2]!.notes = [testNote(104, 5, "five "), testNote(105, 7, "seven")];
    source.singers[1]!.lines = [
      { id: 20, switchStart: null, switchEnd: null, notes: [testNote(200, 6, "a")] },
      { id: 21, switchStart: null, switchEnd: null, notes: [testNote(201, 7.5, "b")] },
    ];
    Object.assign(source.singers[1]!.lines[0]!, { switchStart: 6.5, switchEnd: 7.2 });
    const { doc, run } = setup(source);
    run((tx) => removeSinger(tx, doc.chart(), 2, { merge: true }));
    const lines = doc.chart().singers[0]!.lines;
    expect(
      lines
        .flatMap((line) => line.notes)
        .map((note) => note.lyric.trim())
        .toSorted(),
    ).toEqual(["a", "b", "five", "four", "one", "seven", "three", "two"]);
    // P1's "seven" starts at 7, inside the switch's 6.5 to 7.2: its start stays, its end goes.
    expect(lines.find((line) => line.notes.some((note) => note.lyric === "a"))).toMatchObject({
      switchStart: 6.5,
      switchEnd: null,
    });
    const breaks = new Map(lineBreaks(doc.chart()).map((item) => [item.lineId, item.time]));
    lines.forEach((line, i) => {
      expect(line.notes.length).toBeGreaterThan(0);
      const next = lines[i + 1];
      if (!next) return;
      const end = Math.max(...line.notes.map((note) => note.start + note.duration));
      expect(end).toBeLessThanOrEqual(next.notes[0]!.start + 1e-9);
      expect(breaks.get(line.id)!).toBeGreaterThanOrEqual(end - 1e-9);
      expect(breaks.get(line.id)!).toBeLessThanOrEqual(next.notes[0]!.start + 1e-9);
      if (line.switchEnd !== null) expect(line.switchEnd).toBeLessThanOrEqual(next.notes[0]!.start + 1e-9);
    });
    doc.undo();
    flush();
    expect(doc.chart()).toEqual(source);
  });

  it("removes P1 with its notes, making P2 the first singer, and undoes exactly", () => {
    const source = duet();
    const { doc, run } = setup(source);
    run((tx) => removeSinger(tx, doc.chart(), 1, { merge: false }));
    expect(doc.chart().singers.map((singer) => [singer.id, singer.index, singer.name])).toEqual([[2, 1, "Ben"]]);
    expect(words(doc.chart(), 1)).toEqual(["late"]);
    doc.undo();
    flush();
    expect(doc.chart()).toEqual(source);
  });

  it("removes a singer by moving its notes to the other, overlapping where both sing", () => {
    const source = duet();
    source.singers[1]!.lines[0]!.notes = [testNote(200, 1, "same")];
    source.singers[1]!.lines.push({ id: 21, switchStart: null, switchEnd: null, notes: [] });
    const { doc, run } = setup(source);
    const moved = run((tx) => removeSinger(tx, doc.chart(), 2, { merge: true }));
    expect(moved).toHaveLength(1);
    expect(doc.chart().singers).toHaveLength(1);
    const notes = doc.chart().singers[0]!.lines.flatMap((line) => line.notes);
    expect(notes.filter((note) => note.start === 1).map((note) => note.lyric)).toEqual(
      expect.arrayContaining(["one ", "same"]),
    );
    doc.undo();
    flush();
    expect(doc.chart()).toEqual(source);
  });
});
