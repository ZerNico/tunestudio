import { describe, expect, it } from "vitest";

import { makeChart, type ChartEngines } from "./pipeline";

describe("makeChart", () => {
  it("runs no further model once it's cancelled", async () => {
    const controller = new AbortController();
    const ran: string[] = [];
    const unused = (name: string) => () => {
      ran.push(name);
      return Promise.reject(new Error(`${name} ran`));
    };
    const engines: ChartEngines = {
      trackPitch: (samples) => {
        ran.push("trackPitch");
        // Cancelled while the pitch is worked out.
        controller.abort();
        return Promise.resolve(new Float32Array(Math.floor(samples.length / 160)));
      },
      beatLogits: unused("beatLogits"),
      alignerOutputs: unused("alignerOutputs"),
      forcedAlign: unused("forcedAlign"),
      transcribeNotes: unused("transcribeNotes"),
      harmonicRatios: unused("harmonicRatios"),
      predictPitchShifts: unused("predictPitchShifts"),
      predictNoteEnds: unused("predictNoteEnds"),
    };
    const input = {
      vocals16k: new Float32Array(16_000),
      vocals44k: new Float32Array(44_100),
      mix22k: new Float32Array(22_050),
      lines: [{ text: "la la", start: null, end: null }],
      language: { name: "english", code: "eng" },
    };
    await expect(makeChart(input, engines, () => {}, controller.signal)).rejects.toThrow(/abort/i);
    expect(ran).toEqual(["trackPitch"]);
  });
});
