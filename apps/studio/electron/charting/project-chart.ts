/**
 * A generated chart as a Tune Studio project chart: the headers the PoC writes (#BPM to three decimals, #GAP in
 * whole milliseconds) and every note and line break in seconds on that rounded grid, so exporting the project
 * writes the same beats as the PoC's .txt.
 */
import { ticksToSeconds } from "@tunestudio/ultrastar";

import type { ProjectChart, SongDetails } from "../ultrastar/chart-mapping";
import type { ChartResult } from "./pipeline";
import { bpmHeader, gapHeader } from "./song";

/** The song's own details; the rest of the song row comes from the chart. */
export type ChartSongDetails = Pick<
  SongDetails,
  "title" | "artist" | "language" | "year" | "genre" | "edition" | "creator"
>;

export function toProjectChart(result: ChartResult, details: ChartSongDetails): ProjectChart {
  const bpm = Number(bpmHeader(result.grid.bpm));
  const gapMs = gapHeader(result.grid.gap);
  const grid = { bpm, gap: gapMs };
  const beatSeconds = 15 / bpm;
  return {
    song: {
      ...details,
      bpm,
      gap: gapMs / 1000,
      videoGap: null,
      start: null,
      end: null,
      previewStart: null,
      medleyStart: null,
      medleyEnd: null,
      extraHeaders: [],
      youtubeId: null,
      youtubeAudioId: null,
    },
    singers: [
      {
        index: 1,
        name: null,
        lines: result.lines.map((notes, i) => ({
          // The break after a line, from the PoC's line_breaks: the last line has none.
          switchStart: i < result.breaks.length ? ticksToSeconds(result.breaks[i]!, grid) : null,
          switchEnd: null,
          notes: notes.map((note) => ({
            start: ticksToSeconds(note.start, grid),
            duration: note.length * beatSeconds,
            pitch: note.pitch + 60,
            lyric: note.text,
            type: note.type,
          })),
        })),
      },
    ],
  };
}
