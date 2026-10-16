import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import type { ChartChange } from "~/lib/native/contract";
import type { EditorChart } from "~/lib/native/types";

import { lineBreaks } from "./chart";
import { type Clip, copyNotes, pasteNotes } from "./clipboard";
import { createChartDocument } from "./document";
import { invert } from "./history";
import { testNote as note, testSong } from "./test-chart";

/** Grid: 0.05 s steps from 1 s. Line 10's break is stored at 2.5 s; line 11 starts at 3 s. */
const chart: EditorChart = {
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
          switchStart: 2.5,
          switchEnd: null,
          notes: [note(100, 1, "We "), note(101, 1.5, "wa"), note(102, 1.8, "~lk ")],
        },
        { id: 11, switchStart: null, switchEnd: null, notes: [note(103, 3, "on "), note(104, 3.5, "and")] },
      ],
    },
  ],
};

function setup(start: EditorChart = chart) {
  return createRoot(() => {
    const [selection, setSelection] = createSignal<number[]>([]);
    const saved: ChartChange[][] = [];
    const doc = createChartDocument<number[]>({
      chart: start,
      save: async (changes) => void saved.push(changes),
      onFailed: () => {},
      selection,
      setSelection,
    });
    const paste = (clip: Clip, at: number, length = 10) => {
      let ids: number[] = [];
      doc.edit("Paste", (tx) => (ids = pasteNotes(tx, doc.chart(), clip, { singerId: 1, at, length })), {
        selectionAfter: () => ids,
      });
      flush();
      return ids;
    };
    return { doc, paste, saved, selection };
  });
}

/** Problems with the line structure: empty lines, a switch before its line's last note ends or after the next starts. */
function problems(value: EditorChart): string[] {
  const found: string[] = [];
  const breaks = new Map(lineBreaks(value).map((item) => [item.lineId, item]));
  for (const singer of value.singers) {
    singer.lines.forEach((line, i) => {
      if (line.notes.length === 0) found.push(`line ${line.id} is empty`);
      const next = singer.lines[i + 1];
      if (!next || line.notes.length === 0) return;
      const end = Math.max(...line.notes.map((item) => item.start + item.duration));
      const time = breaks.get(line.id)?.time ?? line.switchStart ?? end;
      if (time < end - 1e-6) found.push(`line ${line.id} switches at ${time}, before its notes end at ${end}`);
      if (time > next.notes[0]!.start + 1e-6) found.push(`line ${line.id} switches after line ${next.id} starts`);
      if (line.switchStart !== null && line.switchStart < end - 1e-6)
        found.push(`line ${line.id} stores a switch inside`);
    });
  }
  return found;
}

/** Whether the changes apply in order: notes only on lines that exist by then, lines deleted only once empty. */
function inOrder(changes: readonly ChartChange[], lines: Iterable<number>, noteLines: Map<number, number>): boolean {
  const live = new Set(lines);
  const notes = new Map(noteLines);
  for (const change of changes) {
    if (change.table === "line") {
      if (change.after) live.add(change.id);
      else if ([...notes.values()].includes(change.id)) return false;
      else live.delete(change.id);
    } else if (change.table === "note") {
      if (change.after && !live.has(change.after.lineId)) return false;
      if (change.after) notes.set(change.id, change.after.lineId);
      else notes.delete(change.id);
    }
  }
  return true;
}

const clipOf = (value: EditorChart, ids: number[]) => copyNotes(value, new Set(ids))!;

describe("pasting", () => {
  it("moves a stored break a pasted note covers to the nearer edge, keeping every note in the line it starts in", () => {
    const { paste, doc } = setup();
    const long: Clip = {
      notes: [{ offset: 0, duration: 2, pitch: 60, lyric: "la", type: "normal" }],
      breaks: [],
      text: "la",
      startsLine: false,
      endsLine: false,
    };
    // 2–4 s covers the break at 2.5 (its stretch with "~lk", 1.8–4, is nearer its start).
    paste(long, 2);
    expect(problems(doc.chart())).toEqual([]);
    const [first, second] = doc.chart().singers[0]!.lines;
    expect(first!.notes.map((item) => item.id)).toEqual([100, 101]);
    expect(first!.switchStart).toBeCloseTo(1.8, 9);
    expect(second!.notes).toHaveLength(4);
  });

  it("brings a multi-line clip's lines, in changes that apply in order forwards and undone", async () => {
    const { paste, doc, saved, selection } = setup();
    const ids = paste(clipOf(chart, [100, 101, 102, 103, 104]), 6);
    expect(problems(doc.chart())).toEqual([]);
    const lines = doc.chart().singers[0]!.lines;
    expect(lines.map((line) => line.notes.length)).toEqual([3, 2, 3, 2]);
    await doc.saved();
    const changes = saved[0]!;
    const before = new Map(chart.singers[0]!.lines.flatMap((line) => line.notes.map((item) => [item.id, line.id])));
    expect(inOrder(changes, [10, 11], before)).toBe(true);
    const after = new Map(lines.flatMap((line) => line.notes.map((item) => [item.id, line.id])));
    expect(
      inOrder(
        invert(changes),
        lines.map((line) => line.id),
        after,
      ),
    ).toBe(true);
    // Undo takes it all back; redo selects the pasted notes again.
    doc.undo();
    flush();
    expect(doc.chart()).toEqual(chart);
    doc.redo();
    flush();
    expect(selection()).toEqual(ids);
  });

  it("cuts notes short at the song's end and leaves out those past it", () => {
    const { paste, doc } = setup();
    const ids = paste(clipOf(chart, [103, 104]), 9.8, 10);
    expect(ids).toHaveLength(1);
    const pasted = doc
      .chart()
      .singers[0]!.lines.flatMap((line) => line.notes)
      .find((item) => item.id === ids[0]);
    expect(pasted).toMatchObject({ start: expect.closeTo(9.8, 9), duration: expect.closeTo(0.2, 9) });
    expect(paste(clipOf(chart, [103]), 9.99, 10)).toEqual([]);
  });

  it("pastes into a chart without lines", () => {
    const empty: EditorChart = { ...chart, singers: [{ id: 1, index: 1, name: null, lines: [] }] };
    const { paste, doc } = setup(empty);
    paste(clipOf(chart, [100, 101, 102, 103, 104]), 2);
    expect(doc.chart().singers[0]!.lines.map((line) => line.notes.length)).toEqual([3, 2]);
    expect(problems(doc.chart())).toEqual([]);
  });

  it("pastes thousands of notes quickly", () => {
    const lines = Array.from({ length: 300 }, (_, l) => ({
      id: 1000 + l,
      switchStart: null,
      switchEnd: null,
      notes: Array.from({ length: 10 }, (_, n) => note(10000 + l * 10 + n, 1 + l * 4 + n * 0.3, "la", 0.2)),
    }));
    const long: EditorChart = { ...chart, singers: [{ id: 1, index: 1, name: null, lines }] };
    const { paste, doc } = setup(long);
    const clip = clipOf(
      long,
      lines.flatMap((line) => line.notes.map((item) => item.id)),
    );
    const started = performance.now();
    expect(paste(clip, 1300, 3000)).toHaveLength(3000);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(problems(doc.chart())).toEqual([]);
  });
});
