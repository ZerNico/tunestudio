import fs from "node:fs";
import path from "node:path";

import { serializeUltraStar } from "@tunestudio/ultrastar";
import { describe, expect, it } from "vitest";

import { projectToChart } from "../ultrastar/chart-mapping";
import { callsOf, GOLDENS, goldenSongs, loadGolden } from "./goldens";
import type { Note } from "./notes";
import { toProjectChart } from "./project-chart";

const details = {
  title: "T",
  artist: "A",
  language: ["English"],
  year: null,
  genre: null,
  edition: null,
  creator: null,
};
const untagged = <T extends object>(x: T & { $type?: string }): T => {
  const { $type: _, ...rest } = x;
  return rest as T;
};

/** The note and line-break lines of an UltraStar text. */
const body = (text: string) => text.split(/\r?\n/).filter((line) => /^[:*FRG-] /.test(line));

describe("project chart", () => {
  it("rounds the grid like the PoC's headers and keeps the beats", () => {
    const n = (start: number, length: number, pitch: number, text: string): Note => ({
      type: "normal",
      start,
      length,
      pitch,
      text,
    });
    const chart = toProjectChart(
      {
        grid: { bpm: 420.00399999, gap: 4.9476983 },
        lines: [[n(0, 4, 2, "Hel"), n(4, 4, 4, "lo ")], [n(20, 8, 0, "you ")]],
        breaks: [12],
        fit: null,
      },
      details,
    );
    expect([chart.song.bpm, chart.song.gap]).toEqual([420.004, 4.948]);
    expect(body(serializeUltraStar(projectToChart(chart, {})))).toEqual([
      ": 0 4 2 Hel",
      ": 4 4 4 lo ",
      "- 12",
      ": 20 8 0 you ",
    ]);
  });
});

describe.skipIf(!goldenSongs().length)("project chart against the PoC's .txt", () => {
  for (const song of goldenSongs()) {
    it(song, () => {
      const [built] = callsOf(loadGolden(song), "autotuner.chart.build_song");
      const grid = untagged(built!.args[1] as { bpm: number; gap: number; $type: string });
      const result = built!.result as { voices: (Note & { $type: string })[][][]; breaks: Record<string, number> };
      const chart = toProjectChart(
        { grid, lines: result.voices[0]!.map((l) => l.map(untagged)), breaks: Object.values(result.breaks), fit: null },
        details,
      );
      const expected = fs.readFileSync(path.join(GOLDENS!, song, "chart.txt"), "utf8");
      expect(body(serializeUltraStar(projectToChart(chart, {})))).toEqual(body(expected));
    });
  }
});
