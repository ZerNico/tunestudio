import { describe, expect, it, vi } from "vitest";

import { chartRange, type RangeEngines } from "./range-chart";

const input = () => ({
  vocals16k: new Float32Array(8 * 16000).fill(0.1),
  vocals44k: new Float32Array(8 * 44100).fill(0.1),
  range: { start: 2.37, end: 6.5 },
  lines: ["(da) da", "oh & hey!"],
  language: { name: "english", code: "eng" },
  grid: { bpm: 287.12345, gap: 0.123456 },
  songMidi: new Float32Array(800).fill(69),
});

function engines(): RangeEngines {
  return {
    trackPitch: vi.fn<RangeEngines["trackPitch"]>(async (samples) =>
      new Float32Array(Math.floor(samples.length / 160)).fill(440),
    ),
    alignerOutputs: vi.fn<RangeEngines["alignerOutputs"]>(async (samples) => ({
      emissions: new Float32Array(),
      frames: Math.floor(samples.length / 320),
      syllableStarts: new Float32Array(),
    })),
    forcedAlign: vi.fn<RangeEngines["forcedAlign"]>(async (_emissions, _classes, from, to, targets) => {
      const path = new Int32Array(to - from);
      const step = Math.floor(path.length / (targets.length + 1));
      if (step < 2) throw new Error("The text is too long for this part of the song.");
      targets.forEach((target, i) => {
        path[(i + 1) * step] = target;
      });
      return { path, scores: new Float32Array(path.length).fill(-0.1) };
    }),
    transcribeNotes: vi.fn<RangeEngines["transcribeNotes"]>(async (_samples, requests) => {
      const notes = requests.map((request) => {
        let at = 0;
        return request.known.map((duration) => {
          const start = at;
          at += duration;
          return { start: start + 0.01, end: at - 0.01 };
        });
      });
      return {
        counts: notes.map((line) => line.length),
        starts: Float64Array.from(notes.flat(), (note) => note.start),
        ends: Float64Array.from(notes.flat(), (note) => note.end),
        voiced: new Uint8Array(notes.flat().length).fill(1),
        midi: new Float64Array(notes.flat().length).fill(69),
      };
    }),
    predictPitchShifts: vi.fn<RangeEngines["predictPitchShifts"]>(async (matrix) =>
      Float32Array.from({ length: (matrix.length / 24) * 5 }, (_, i) => (i % 5 === 2 ? 1 : 0)),
    ),
    predictNoteEnds: vi.fn<RangeEngines["predictNoteEnds"]>(async (matrix) => new Float32Array(matrix.length / 27)),
    harmonicRatios: vi.fn<RangeEngines["harmonicRatios"]>(async (_samples, notes) =>
      new Float64Array(notes.length * 2).fill(NaN),
    ),
  };
}

describe("charting a passage", () => {
  it("keeps exact project grid, supplied lines, parentheses and standalone punctuation", async () => {
    const run = engines();
    const source = input();
    const result = await chartRange(source, run);
    expect(result.bpm).toBe(source.grid.bpm);
    expect(result.gap).toBe(source.grid.gap);
    expect(
      result.lines.map((line) =>
        line.notes
          .map((note) => note.lyric)
          .join("")
          .replaceAll("~", "")
          .trim(),
      ),
    ).toEqual(source.lines);
    for (const note of result.lines.flatMap((line) => line.notes)) {
      expect(note.start).toBeGreaterThanOrEqual(source.range.start);
      expect(note.start + note.duration).toBeLessThanOrEqual(source.range.end + 1e-6);
      const tick = ((note.start - result.gap) * result.bpm) / 15;
      expect(tick).toBeCloseTo(Math.round(tick), 8);
      expect(note.type).toBe("normal");
      expect(Number.isInteger(note.pitch)).toBe(true);
    }
    expect(run.forcedAlign).toHaveBeenCalledWith(expect.anything(), 31, 50, 258, expect.any(Int32Array));
    // 1.36 s origin, shared by both sample rates, leaves one second before the reviewed passage.
    expect(run.trackPitch).toHaveBeenCalledWith(expect.objectContaining({ length: Math.floor(7.5 * 16000) - 21760 }));
    expect(run.transcribeNotes).toHaveBeenCalledWith(
      expect.objectContaining({ length: Math.floor(7.5 * 44100) - 59976 }),
      expect.anything(),
      1,
      expect.any(Function),
    );
  });

  it("charts a range ending a little past the decoded vocals up to their end", async () => {
    const result = await chartRange({ ...input(), range: { start: 2.37, end: 8.03 } }, engines());
    for (const note of result.lines.flatMap((line) => line.notes))
      expect(note.start + note.duration).toBeLessThanOrEqual(8);
  });

  it("charts a full-song range longer than a minute", async () => {
    const duration = 180;
    const source = {
      ...input(),
      vocals16k: new Float32Array(duration * 16000).fill(0.1),
      vocals44k: new Float32Array(duration * 44100).fill(0.1),
      songMidi: new Float32Array(duration * 100).fill(69),
      range: { start: 0, end: duration },
    };
    const result = await chartRange(source, engines());
    expect(result.lines).toHaveLength(source.lines.length);
    expect(result.bpm).toBe(source.grid.bpm);
    expect(result.gap).toBe(source.grid.gap);
    for (const line of result.lines) {
      expect(line.notes.length).toBeGreaterThan(0);
      for (const note of line.notes) {
        expect(note.start).toBeGreaterThanOrEqual(0);
        expect(note.start + note.duration).toBeLessThanOrEqual(duration);
      }
    }
  });

  it.each([[], [""], ["---"], ["привет мир"], ["2 4 you"]].map((lines) => ({ lines })))(
    "rejects unusable lyrics before model work: $lines",
    async ({ lines }) => {
      const run = engines();
      await expect(chartRange({ ...input(), lines }, run)).rejects.toThrow();
      expect(run.trackPitch).not.toHaveBeenCalled();
    },
  );

  it("rejects silent vocals before alignment even if FCPE returns a pitch", async () => {
    const run = engines();
    await expect(chartRange({ ...input(), vocals16k: new Float32Array(8 * 16000) }, run)).rejects.toThrow(
      "Nothing is sung",
    );
    expect(run.alignerOutputs).not.toHaveBeenCalled();
  });

  it("rejects a line with only fabricated fallback notes", async () => {
    const run = engines();
    run.transcribeNotes = async () => ({
      counts: [0, 0],
      starts: new Float64Array(),
      ends: new Float64Array(),
      midi: new Float64Array(),
      voiced: new Uint8Array(),
    });
    await expect(chartRange(input(), run)).rejects.toThrow("Not all syllables");
  });

  it("names every line with an unsung syllable at once", async () => {
    const run = engines();
    const original = run.transcribeNotes;
    run.transcribeNotes = async (...args) => {
      const output = await original(...args);
      // Nothing sung in the first line, and the second's last syllable unsung.
      output.voiced.fill(0, 0, output.counts[0]);
      output.voiced[output.voiced.length - 1] = 0;
      return output;
    };
    await expect(chartRange(input(), run)).rejects.toThrow("Not all syllables have sung notes in lines 1, 2.");
  });

  it("rejects an unsung syllable even when the rest of its line has notes", async () => {
    const run = engines();
    const original = run.transcribeNotes;
    run.transcribeNotes = async (...args) => {
      const output = await original(...args);
      output.voiced[output.voiced.length - 1] = 0;
      return output;
    };
    await expect(chartRange(input(), run)).rejects.toThrow("Not all syllables");
    expect(run.predictPitchShifts).not.toHaveBeenCalled();
  });

  it("restores standalone punctuation without moving syllable boundaries", async () => {
    const source = { ...input(), lines: ["hello world"] };
    const plain = engines();
    const punctuated = engines();
    const before = await chartRange(source, plain);
    const after = await chartRange({ ...source, lines: ["( hello , world )"] }, punctuated);
    expect(vi.mocked(punctuated.transcribeNotes).mock.calls[0]![1]).toEqual(
      vi.mocked(plain.transcribeNotes).mock.calls[0]![1],
    );
    const times = (result: typeof before) =>
      result.lines.flatMap((line) => line.notes.map(({ start, duration }) => ({ start, duration })));
    expect(times(after)).toEqual(times(before));
    expect(
      after.lines[0]!.notes.map((note) => note.lyric)
        .join("")
        .trim(),
    ).toBe("( hello , world )");
  });

  it("does not describe an unexpected aligner error as a lyrics fit problem", async () => {
    const run = engines();
    run.forcedAlign = async () => {
      throw new Error("The alignment request is invalid.");
    };
    await expect(chartRange(input(), run)).rejects.toThrow("The alignment request is invalid.");
  });

  it("rejects impossible bounds and sub-tick ranges before models", async () => {
    // Past the audio, after trimming to its end, and shorter than a grid step.
    for (const range of [
      { start: 9, end: 12 },
      { start: 7.99, end: 9 },
      { start: 2, end: 2.001 },
    ]) {
      const run = engines();
      await expect(chartRange({ ...input(), range }, run)).rejects.toThrow();
      expect(run.trackPitch).not.toHaveBeenCalled();
    }
  });

  it("bounds GAME and learned end overshoots without losing words", async () => {
    const run = engines();
    const original = run.transcribeNotes;
    run.transcribeNotes = async (...args) => {
      const output = await original(...args);
      output.starts[0] = -1;
      output.ends[output.ends.length - 1] = output.ends.at(-1)! + 0.1;
      return output;
    };
    run.predictNoteEnds = async (matrix) => new Float32Array(matrix.length / 27).fill(10);
    const source = input();
    const result = await chartRange(source, run);
    const notes = result.lines.flatMap((line) => line.notes);
    expect(notes[0]!.start).toBeGreaterThanOrEqual(source.range.start);
    expect(notes.at(-1)!.start + notes.at(-1)!.duration).toBeLessThanOrEqual(source.range.end);
    expect(result.lines).toHaveLength(source.lines.length);
    for (let i = 1; i < notes.length; i++)
      expect(notes[i]!.start).toBeGreaterThanOrEqual(notes[i - 1]!.start + notes[i - 1]!.duration - 1e-6);
  });

  it("reports lyrics that cannot fit rather than returning partial lines", async () => {
    const source = { ...input(), range: { start: 2, end: 2.2 }, lines: ["many words ".repeat(30)] };
    await expect(chartRange(source, engines())).rejects.toThrow("Choose more time or fewer words");
  });

  it("uses German and preserves punctuation on both sides of sung words", async () => {
    const source = { ...input(), lines: ["( ja )", "schön!"], language: { name: "german", code: "deu" } };
    const run = engines();
    const result = await chartRange(source, run);
    expect(
      result.lines.map((line) =>
        line.notes
          .map((note) => note.lyric)
          .join("")
          .trim(),
      ),
    ).toEqual(source.lines);
    expect(run.transcribeNotes).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0, expect.any(Function));
  });

  it("does not return results when cancelled after the last model", async () => {
    const run = engines();
    const controller = new AbortController();
    run.harmonicRatios = async (_samples, notes) => {
      controller.abort();
      return new Float64Array(notes.length * 2);
    };
    await expect(chartRange(input(), run, undefined, controller.signal)).rejects.toThrow();
  });

  it("stops before the next model", async () => {
    const run = engines();
    const controller = new AbortController();
    run.trackPitch = async () => {
      controller.abort();
      return new Float32Array(600);
    };
    await expect(chartRange(input(), run, undefined, controller.signal)).rejects.toThrow();
    expect(run.alignerOutputs).not.toHaveBeenCalled();
  });
});
