import { describe, expect, it } from "vitest";

import {
  splitNote,
  mergeNotes,
  transposeNotes,
  gridFromMetadata,
  ticksToSeconds,
  secondsToTicks,
  tickDuration,
  snapToGrid,
  quantizeNoteTiming,
  midiToPitchName,
  createEmptyDocument,
  validateDocument,
  type ChartNote,
} from "./index";

const base: ChartNote = Object.freeze({
  id: "a",
  lineId: "line-a",
  start: 1,
  duration: 2,
  pitch: 60,
  lyric: "blue hour ",
  type: "normal",
  player: 2,
});

describe("split", () => {
  it("preserves IDs/attributes and full duration without mutating", () => {
    const [left, right] = splitNote(base, 1.75, { rightId: "b" });
    expect(left).toEqual({ ...base, duration: 0.75 });
    expect(right).toEqual({ ...base, id: "b", start: 1.75, duration: 1.25, lyric: "~" });
    expect(base.duration).toBe(2);
  });
  it("splits exact whitespace and Unicode at code-point offsets", () => {
    const [left, right] = splitNote({ ...base, lyric: "🌙 blue " }, 2, { lyricOffset: 2 });
    expect(left.lyric).toBe("🌙 ");
    expect(right.lyric).toBe("blue ");
    expect(left.lyric + right.lyric).toBe("🌙 blue ");
  });
  it("allows splitting lyric at either edge", () => {
    expect(splitNote(base, 2, { lyricOffset: 0 })[0]!.lyric).toBe("");
    expect(splitNote(base, 2, { lyricOffset: base.lyric.length })[1]!.lyric).toBe("");
  });
  it.each([0, 1, 3, 4, NaN, Infinity])("rejects boundary/outside split %s", (time) => {
    expect(() => splitNote(base, time)).toThrow(/strictly inside/);
  });
  it.each([-1, 100, 1.5, NaN])("rejects invalid lyric offset %s", (offset) => {
    expect(() => splitNote(base, 2, { lyricOffset: offset })).toThrow(/offset/);
  });
  it("requires a distinct nonempty new ID", () => {
    expect(() => splitNote(base, 2, { rightId: "a" })).toThrow(/ID/);
    expect(() => splitNote(base, 2, { rightId: "" })).toThrow(/ID/);
    expect(splitNote(base, 2)[1]!.id).not.toBe(splitNote(base, 2)[1]!.id);
  });
});

describe("merge and transpose", () => {
  const second: ChartNote = Object.freeze({ ...base, id: "b", start: 3, duration: 1, lyric: "glow" });
  it("merges in temporal order, preserving left ID and exact lyrics", () => {
    const input = Object.freeze([second, base]);
    expect(mergeNotes(input)).toEqual({ ...base, duration: 3, lyric: "blue hour glow" });
    expect(input[0]!).toBe(second);
  });
  it("allows overlapping notes and uses the largest end", () => {
    expect(mergeNotes([base, { ...second, start: 2, duration: 4 }]).duration).toBe(5);
  });
  it("does not fill a rest or flatten mixed pitches/types without explicit overrides", () => {
    expect(() => mergeNotes([base, { ...second, start: 4 }])).toThrow(/rest/);
    expect(mergeNotes([base, { ...second, start: 4 }], { allowGaps: true }).duration).toBe(4);
    expect(() => mergeNotes([base, { ...second, pitch: 62 }])).toThrow(/different pitches/);
    expect(() => mergeNotes([base, { ...second, type: "golden" }])).toThrow(/different types/);
    expect(
      mergeNotes([base, { ...second, type: "golden", pitch: 62 }], { pitch: 61, type: "normal", lyric: "new " }),
    ).toEqual({ ...base, duration: 3, pitch: 61, lyric: "new " });
  });
  it("rejects cross-line/player merges and duplicate IDs", () => {
    expect(() => mergeNotes([base, { ...second, lineId: "other" }])).toThrow(/same lyric line/);
    expect(() => mergeNotes([base, { ...second, player: 1 }])).toThrow(/same lyric line/);
    expect(() => mergeNotes([base, base])).toThrow(/duplicate/);
    expect(() => mergeNotes([])).toThrow(/at least one/);
    expect(() => mergeNotes([base], { lyric: "bad\nlyric" })).toThrow(/single-line/);
  });
  it("can split and merge without changing time or text", () => {
    const halves = splitNote(base, 2.333, { lyricOffset: 5 });
    expect(mergeNotes(halves)).toEqual(base);
  });
  it("transposes selected notes, preserves identities/seconds, and does not clamp", () => {
    const notes = Object.freeze([base, second]);
    const result = transposeNotes(notes, -12, new Set(["b"]));
    expect(result).not.toBe(notes);
    expect(result[0]!).toBe(base);
    expect(result[1]!).toEqual({ ...second, pitch: 48 });
    expect(transposeNotes([base], 72)[0]!.pitch).toBe(132);
    expect(second.pitch).toBe(60);
  });
  it.each([0.5, NaN, Infinity])("rejects invalid transposition %s", (semitones) => {
    expect(() => transposeNotes([base], semitones)).toThrow(/whole number/);
  });
});

describe("grid and pitch naming", () => {
  const grid = { bpm: 120, gap: 11251 };
  it("converts seconds/ticks with GAP included exactly once", () => {
    expect(tickDuration(120)).toBe(0.125);
    expect(ticksToSeconds(-4, grid)).toBe(10.751);
    expect(secondsToTicks(10.751, grid)).toBeCloseTo(-4, 10);
    expect(gridFromMetadata({ BPM: "123,4", GAP: " 11251,5 " })).toEqual({ bpm: 123.4, gap: 11251.5 });
  });
  it("snaps around GAP and supports fractional or musical beat steps", () => {
    expect(snapToGrid(11.33, grid)).toBeCloseTo(11.376, 10);
    expect(snapToGrid(11.49, grid, 4)).toBeCloseTo(11.251, 10);
    expect(snapToGrid(11.31, grid, 0.5)).toBeCloseTo(11.3135, 10);
  });
  it("rounds edges rather than rounding duration independently", () => {
    expect(quantizeNoteTiming(0.06, 0.14, { bpm: 120, gap: 0 })).toEqual({ start: 0, duration: 2 });
    expect(quantizeNoteTiming(0.01, 0.01, { bpm: 120, gap: 0 })).toEqual({ start: 0, duration: 1 });
  });
  it.each([0, -120, NaN, Infinity])("rejects invalid BPM %s", (bpm) => {
    expect(() => ticksToSeconds(1, { bpm, gap: 0 })).toThrow(/BPM/);
  });
  it("rejects invalid grid steps, times, gaps and durations", () => {
    expect(() => snapToGrid(1, grid, 0)).toThrow(/step/);
    expect(() => secondsToTicks(NaN, grid)).toThrow(/finite/);
    expect(() => ticksToSeconds(Infinity, grid)).toThrow(/finite/);
    expect(() => ticksToSeconds(1, { bpm: 120, gap: NaN })).toThrow(/GAP/);
    expect(() => quantizeNoteTiming(1, 0, grid)).toThrow(/Duration/);
    expect(() => quantizeNoteTiming(1e18, 1000, grid)).toThrow(/safe integer/);
  });
  it.each([
    [60, "C4"],
    [69, "A4"],
    [61, "C♯4"],
    [0, "C-1"],
    [127, "G9"],
    [-1, "B-2"],
  ])("names MIDI %s as %s", (midi, name) => {
    expect(midiToPitchName(midi as number)).toBe(name);
  });
});

describe("document factories", () => {
  it("makes independent empty documents", () => {
    const a = createEmptyDocument();
    const b = createEmptyDocument();
    expect(a.id).not.toBe(b.id);
    a.metadata.TITLE = "Changed";
    expect(b.metadata.TITLE).toBe("Untitled");
    expect(validateDocument(b).filter((item) => item.severity === "error")).toEqual([]);
  });
});
