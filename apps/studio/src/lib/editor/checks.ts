/**
 * What's wrong with the chart, worked out as it is edited: notes on top of each other, syllables left empty, notes
 * past the song's end or outside the part the game plays (#START, #END), and stored line breaks inside a note. Each
 * problem names its notes (or line break) and where it is, so the editor can show it.
 */
import type { EditorChart } from "~/lib/native/types";

import { lineBreaks } from "./chart";
import { overlapping as overlappingNotes } from "./edits";

const EPSILON = 1e-6;

export interface ChartProblem {
  /** Stable while the problem stays: what it is and its first note (or line break). */
  key: string;
  message: string;
  /** The notes it is about (none for a line break). */
  noteIds: number[];
  /** The line break it is about, by the line it ends. */
  lineId?: number;
  /** Where it is (seconds), from its start to its end. */
  start: number;
  end: number;
}

interface CheckedNote {
  id: number;
  start: number;
  end: number;
}

/** Runs of notes that touch each other's time, as one problem each. */
function runs(notes: CheckedNote[], key: string, message: string): ChartProblem[] {
  const problems: ChartProblem[] = [];
  for (const note of notes) {
    const last = problems.at(-1);
    if (last && note.start < last.end + EPSILON) {
      last.noteIds.push(note.id);
      last.end = Math.max(last.end, note.end);
    } else {
      problems.push({ key: `${key}:${note.id}`, message, noteIds: [note.id], start: note.start, end: note.end });
    }
  }
  return problems;
}

/** `notes` as one problem, if there are any. */
function together(notes: CheckedNote[], key: string, message: string): ChartProblem[] {
  const first = notes[0];
  if (!first) return [];
  const ids = notes.map((note) => note.id);
  const end = Math.max(...notes.map((note) => note.end));
  return [{ key: `${key}:${first.id}`, message, noteIds: ids, start: first.start, end }];
}

/** Every problem in the chart, by time. `length` is the song's (seconds; 0 while unknown). */
export function chartProblems(chart: EditorChart, length: number): ChartProblem[] {
  const problems: ChartProblem[] = [];
  const { start: played, end: stops } = chart.song;
  const overlapping = overlappingNotes(chart);
  for (const singer of chart.singers) {
    const notes = singer.lines
      .flatMap((line) => line.notes)
      .map((note) => ({ id: note.id, start: note.start, end: note.start + note.duration, lyric: note.lyric }))
      .toSorted((a, b) => a.start - b.start);

    // Notes on top of each other, as the roll outlines them.
    problems.push(
      ...runs(
        notes.filter((note) => overlapping.has(note.id)),
        "overlap",
        "Notes overlap",
      ),
    );

    for (const note of notes) {
      if (!note.lyric.trim()) {
        problems.push({
          key: `empty:${note.id}`,
          message: "Empty syllable",
          noteIds: [note.id],
          start: note.start,
          end: note.end,
        });
      }
    }
    if (length > 0) {
      problems.push(
        ...together(
          notes.filter((note) => note.end > length + EPSILON),
          "past-end",
          "Notes after the song's end",
        ),
      );
    }
    if (played !== null) {
      problems.push(
        ...together(
          notes.filter((note) => note.start < played - EPSILON),
          "before-start",
          "Notes before the start mark",
        ),
      );
    }
    if (stops !== null) {
      problems.push(
        ...together(
          notes.filter((note) => note.end > stops + EPSILON),
          "after-end",
          "Notes after the end mark",
        ),
      );
    }
  }

  // A stored line break inside a note (drawn at the gap's edge, written where it is).
  const stored = new Map(chart.singers.flatMap((singer) => singer.lines).map((line) => [line.id, line.switchStart]));
  for (const item of lineBreaks(chart)) {
    const time = stored.get(item.lineId);
    if (time === null || time === undefined) continue;
    if (time < item.gapStart - EPSILON || time > item.gapEnd + EPSILON) {
      problems.push({
        key: `break:${item.lineId}`,
        message: "Line break inside a note",
        noteIds: [],
        lineId: item.lineId,
        start: time,
        end: time,
      });
    }
  }
  return problems.toSorted((a, b) => a.start - b.start);
}
