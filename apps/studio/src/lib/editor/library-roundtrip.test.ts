/**
 * Every chart in a song library through import and export, as the app does it. Local only: set
 * TUNESTUDIO_LIBRARY to a folder of UltraStar songs (searched recursively). Checks that each chart that imports exports
 * the same notes, lines and line breaks, that exporting again changes nothing, and that the editor draws each
 * automatic break where the export writes it. TUNESTUDIO_LIBRARY_REPORT names a file for the full list of problems.
 */
import fs from "node:fs";
import path from "node:path";

import {
  type ChartDocument,
  decodeChart,
  gridFromMetadata,
  parseUltraStar,
  secondsToTicks,
  serializeUltraStar,
} from "@tunestudio/ultrastar";
import { describe, expect, it } from "vitest";

import type { EditorChart } from "~/lib/native/types";

import {
  chartToProject,
  type MediaHeaders,
  MEDIA_HEADERS,
  type ProjectChart,
  projectToChart,
} from "../../../electron/ultrastar/chart-mapping";
import { lineBreaks } from "./chart";

const LIBRARY = process.env.TUNESTUDIO_LIBRARY;
const REPORT = process.env.TUNESTUDIO_LIBRARY_REPORT;

function charts(folder: string): string[] {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return charts(full);
    return entry.name.toLowerCase().endsWith(".txt") ? [full] : [];
  });
}

/** Each singer's lines as the file has them: notes in ticks, and the break after each line (ticks, or null). */
function sung(document: ChartDocument) {
  const grid = gridFromMetadata(document.metadata);
  const tick = (seconds: number) => Math.round(secondsToTicks(seconds, grid));
  const breaks = new Map(document.lineBreaks?.map((item) => [item.lineId, item]));
  const singers = new Map<number, Map<string, { notes: string[]; first: number; switch: string | null }>>();
  for (const note of document.notes) {
    const player = note.player ?? 1;
    const lines = singers.get(player) ?? new Map();
    singers.set(player, lines);
    let line = lines.get(note.lineId);
    if (!line) {
      const item = breaks.get(note.lineId);
      line = {
        notes: [],
        first: note.start,
        switch: item ? `${tick(item.start)}${item.end === undefined ? "" : `-${tick(item.end)}`}` : null,
      };
      lines.set(note.lineId, line);
    }
    line.first = Math.min(line.first, note.start);
    line.notes.push(
      `${tick(note.start)}+${tick(note.start + note.duration) - tick(note.start)} ${note.pitch} ${note.type} ${JSON.stringify(note.lyric)}`,
    );
  }
  return [...singers]
    .toSorted(([a], [b]) => a - b)
    .map(([player, lines]) => ({
      player,
      lines: [...lines.values()]
        .toSorted((a, b) => a.first - b.first)
        .map((line, i, all) => ({
          notes: line.notes.toSorted(),
          // The last line's break means nothing.
          switch: i === all.length - 1 ? null : line.switch,
        })),
    }));
}

/** The chart as the editor gets it from the project. */
function editorChart(chart: ProjectChart): EditorChart {
  let id = 0;
  return {
    bpm: chart.song.bpm,
    gap: chart.song.gap,
    song: { ...chart.song, tags: [], otherHeaders: chart.song.extraHeaders } as never,
    singers: chart.singers.map((singer) => ({
      id: ++id,
      index: singer.index as 1 | 2,
      name: singer.name,
      lines: singer.lines.map((line) => ({
        id: ++id,
        switchStart: line.switchStart,
        switchEnd: line.switchEnd,
        notes: line.notes.map((note) => ({ ...note, id: ++id, pitch: note.pitch + 60, edited: false })),
      })),
    })),
  };
}

function exported(chart: ProjectChart, document: ChartDocument): string {
  const media: MediaHeaders = {};
  for (const key of MEDIA_HEADERS) if (document.metadata[key]) media[key] = document.metadata[key];
  return serializeUltraStar(projectToChart(chart, media));
}

describe.runIf(LIBRARY)("the song library, imported and exported", () => {
  it("keeps every chart's notes, lines and breaks", { timeout: 600_000 }, () => {
    const problems: string[] = [];
    const unreadable = new Map<string, number>();
    let checked = 0;
    let duets = 0;
    let autoBreaks = 0;
    for (const file of charts(LIBRARY!)) {
      const name = path.relative(LIBRARY!, file);
      let original: ChartDocument;
      try {
        original = parseUltraStar(decodeChart(fs.readFileSync(file))).document;
      } catch (error) {
        const reason = (error instanceof Error ? error.message : String(error)).replace(/\d+/g, "#").slice(0, 90);
        unreadable.set(reason, (unreadable.get(reason) ?? 0) + 1);
        continue;
      }
      checked++;
      try {
        const { chart } = chartToProject(original);
        if (chart.singers.length > 1) duets++;
        const text = exported(chart, original);
        const again = parseUltraStar(text).document;
        const before = sung(original);
        const after = sung(again);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          const diff = before.flatMap((singer, s) =>
            singer.lines.flatMap((line, l) => {
              const other = after[s]?.lines[l];
              return JSON.stringify(line) === JSON.stringify(other)
                ? []
                : [`P${singer.player} line ${l + 1}: ${JSON.stringify(line)} → ${JSON.stringify(other)}`];
            }),
          );
          problems.push(`${name}: changed on export\n    ${diff.slice(0, 3).join("\n    ")}`);
          continue;
        }
        const second = exported(chartToProject(again).chart, again);
        if (second !== text) problems.push(`${name}: a second export differs`);

        // The editor draws an automatic break where the export writes it.
        const grid = gridFromMetadata(again.metadata);
        const editor = editorChart(chart);
        const drawn = lineBreaks(editor);
        const written = after.flatMap((singer) => singer.lines.slice(0, -1).map((line) => line.switch));
        const autos = drawn.filter((item) => item.auto);
        autoBreaks += autos.length;
        const byLine = new Map(drawn.map((item) => [item.lineId, item]));
        let index = 0;
        for (const singer of editor.singers) {
          for (const line of singer.lines.slice(0, -1)) {
            const item = byLine.get(line.id);
            const want = written[index++];
            if (!item?.auto) continue;
            const at = String(Math.round(secondsToTicks(item.time, grid)));
            if (at !== want) {
              problems.push(`${name}: P${singer.index} automatic break drawn at beat ${at}, exported at ${want}`);
              break;
            }
          }
        }
      } catch (error) {
        problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const summary = [
      `${checked} charts checked (${duets} duets, ${autoBreaks} automatic breaks), ${problems.length} with problems`,
      `Not readable: ${[...unreadable.values()].reduce((a, b) => a + b, 0)}`,
      ...[...unreadable].toSorted((a, b) => b[1] - a[1]).map(([reason, count]) => `  ${count}× ${reason}`),
      ...problems,
    ].join("\n");
    if (REPORT) fs.writeFileSync(REPORT, summary);
    console.log(summary.split("\n").slice(0, 40).join("\n"));
    expect(problems).toEqual([]);
  });
});
