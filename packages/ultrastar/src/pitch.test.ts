import { describe, expect, it } from "vitest";

import { autoPitchNotes, autoPitchNotesWithDiagnostics, type ChartNote, type PitchFrame } from "./index";

/** Lets a test pass deliberately malformed data where the API expects a typed value. */
const untyped = <T>(value: unknown): T => value as T;

const note: ChartNote = Object.freeze({
  id: "n",
  lineId: "l",
  start: 2,
  duration: 1,
  pitch: 60,
  lyric: "night ",
  type: "normal",
});
const frame = (time: number, midi: number, confidence = 0.9): PitchFrame => Object.freeze({ time, midi, confidence });

describe("cached pitch assistance", () => {
  it("uses absolute audio seconds and preserves all attributes/IDs", () => {
    const notes = [note];
    const frames = [frame(2.1, 64.1), frame(2.4, 64.3), frame(2.8, 63.9)];
    const output = autoPitchNotes(notes, frames);
    expect(output).not.toBe(notes);
    expect(output[0]!).toEqual({ ...note, pitch: 64 });
    expect(note.pitch).toBe(60);
  });

  it("handles unordered frozen caches without sorting or mutating inputs", () => {
    const frames = Object.freeze([frame(2.8, 65), frame(1, 72), frame(2.1, 65), frame(3, 80)]);
    const result = autoPitchNotesWithDiagnostics(Object.freeze([note]), frames);
    expect(result.notes[0]!.pitch).toBe(65);
    expect(frames[0]!.time).toBe(2.8);
    expect(result.updatedIds).toEqual(["n"]);
  });

  it("keeps notes unchanged when cache is absent, empty, low confidence or out of range", () => {
    for (const frames of [[], [frame(2.1, 70, 0.49)], [frame(1.99, 70)], [frame(3, 70)]]) {
      const result = autoPitchNotesWithDiagnostics([note], frames);
      expect(result.notes[0]!).toBe(note);
      expect(result.noEvidenceIds).toEqual(["n"]);
      expect(result.updatedIds).toEqual([]);
    }
  });

  it("uses half-open windows so adjacent notes do not share a frame", () => {
    const next = { ...note, id: "next", start: 3 };
    const result = autoPitchNotes([note, next], [frame(3, 72)]);
    expect(result[0]!.pitch).toBe(60);
    expect(result[1]!.pitch).toBe(72);
  });

  it("includes the start boundary, excludes the end and does not interpolate", () => {
    expect(autoPitchNotes([note], [frame(2, 61), frame(3, 75)])[0]!.pitch).toBe(61);
    expect(autoPitchNotes([note], [frame(1.999, 64), frame(3.001, 64)])[0]!).toBe(note);
  });

  it("uses a confidence-weighted median, robust to isolated octave errors", () => {
    const frames = [frame(2, 60, 1), frame(2.2, 72, 0.5), frame(2.4, 60.2, 1)];
    expect(autoPitchNotes([note], frames)[0]!.pitch).toBe(60);
    expect(autoPitchNotes([note], [frame(2, 64, 1), frame(2.2, 70, 0.5)])[0]!.pitch).toBe(64);
  });

  it("handles a tied median deterministically", () => {
    expect(autoPitchNotes([note], [frame(2, 64), frame(2.5, 66)])[0]!.pitch).toBe(65);
  });

  it("does not invent a scored melody for freestyle or rap", () => {
    const notes: ChartNote[] = ["freestyle", "rap", "golden-rap"].map((type) => ({
      ...note,
      id: type,
      type: type as ChartNote["type"],
    }));
    const result = autoPitchNotesWithDiagnostics(notes, [frame(2, 75)]);
    expect(result.notes).toEqual(notes);
    expect(result.skippedIds).toEqual(["freestyle", "rap", "golden-rap"]);
    expect(autoPitchNotes([{ ...note, type: "golden" }], [frame(2, 75)])[0]!.pitch).toBe(75);
  });

  it("filters invalid/unvoiced cache records and reports the count", () => {
    const invalid = [
      frame(NaN, 64),
      frame(Infinity, 64),
      frame(2, NaN),
      frame(2, Infinity),
      frame(2, -1),
      frame(2, 128),
      frame(2, 64, 0),
      frame(2, 64, -1),
      frame(2, 64, 1.1),
      frame(2, 64, NaN),
      untyped<PitchFrame>(null),
    ];
    const result = autoPitchNotesWithDiagnostics([note], [...invalid, frame(2, 67)]);
    expect(result.notes[0]!.pitch).toBe(67);
    expect(result.ignoredFrameCount).toBe(invalid.length);
  });

  it("honors confidence threshold boundaries but never accepts zero-confidence frames", () => {
    expect(autoPitchNotes([note], [frame(2, 67, 0.5)])[0]!.pitch).toBe(67);
    expect(autoPitchNotes([note], [frame(2, 67, 0.5)], { minConfidence: 0.6 })[0]!).toBe(note);
    expect(autoPitchNotes([note], [frame(2, 67, 0.1)], { minConfidence: 0 })[0]!.pitch).toBe(67);
    expect(autoPitchNotes([note], [frame(2, 67, 0)], { minConfidence: 0 })[0]!).toBe(note);
    expect(autoPitchNotes([note], [frame(2, 67, 1)], { minConfidence: 1 })[0]!.pitch).toBe(67);
  });

  it.each([-1, 1.1, NaN, Infinity])("rejects invalid confidence setting %s", (minConfidence) => {
    expect(() => autoPitchNotes([note], [], { minConfidence })).toThrow(/minConfidence/);
  });

  it("leaves already-correct notes alone and returns an independent empty result", () => {
    const result = autoPitchNotesWithDiagnostics([note], [frame(2.1, 60.1)]);
    expect(result.notes[0]!).toBe(note);
    expect(result.updatedIds).toEqual([]);
    expect(result.noEvidenceIds).toEqual([]);
    expect(autoPitchNotes([], [frame(2, 64)])).toEqual([]);
  });

  it("validates note timing", () => {
    expect(() => autoPitchNotes([{ ...note, duration: 0 }], [])).toThrow(/positive duration/);
    expect(() => autoPitchNotes([{ ...note, start: NaN }], [])).toThrow(/finite timing/);
    expect(() => autoPitchNotes([untyped<ChartNote>(null)], [])).toThrow(/finite timing/);
    expect(() => autoPitchNotes([note], untyped<PitchFrame[]>(null))).toThrow(/arrays/);
    expect(() => autoPitchNotes([{ ...note, start: 1e20, duration: 1 }], [])).toThrow(/positive duration/);
  });
});
