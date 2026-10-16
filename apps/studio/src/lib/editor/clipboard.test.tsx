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

const lines = (value: EditorChart) =>
  value.singers[0]!.lines.map((line) => ({ notes: line.notes.length, at: line.switchStart }));

const clipOf = (value: EditorChart, ids: number[], breaks: number[] = []) =>
  copyNotes(value, new Set(ids), new Set(breaks))!.clip;

describe("pasting", () => {
  it("moves a stored break a pasted note covers to the nearer edge, keeping every note in the line it starts in", () => {
    const { paste, doc } = setup();
    const long: Clip = {
      notes: [{ offset: 0, duration: 2, pitch: 60, lyric: "la", type: "normal" }],
      breaks: [],
      text: "la",
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
    const ids = paste(clipOf(chart, [100, 101, 102, 103, 104], [10]), 6);
    expect(problems(doc.chart())).toEqual([]);
    const lines = doc.chart().singers[0]!.lines;
    // "We walk" joins line 11, where it lands; the break between the copied lines makes "on and" a line again.
    expect(lines.map((line) => line.notes.length)).toEqual([3, 5, 2]);
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

  it("pastes notes without breaks into the line they land in, a default break there going to their nearer end", () => {
    // Line 12 far after: line 11's default break is 2 s after its end (5.8 s), among the pasted notes (5–6.1 s).
    const three: EditorChart = {
      ...chart,
      singers: [
        {
          ...chart.singers[0]!,
          lines: [
            ...chart.singers[0]!.lines,
            { id: 12, switchStart: null, switchEnd: null, notes: [note(105, 9, "on")] },
          ],
        },
      ],
    };
    const { paste, doc } = setup(three);
    paste(clipOf(three, [100, 101, 102]), 5);
    expect(lines(doc.chart())).toEqual([
      { notes: 3, at: 2.5 },
      { notes: 5, at: null },
      { notes: 1, at: null },
    ]);
    expect(problems(doc.chart())).toEqual([]);
  });

  it("brings the selected breaks before and after the notes, as far from them as they were", () => {
    // One line: 1, 2, 6 and 7 s.
    const wide: EditorChart = {
      ...chart,
      singers: [
        {
          ...chart.singers[0]!,
          lines: [
            {
              id: 20,
              switchStart: null,
              switchEnd: null,
              notes: [note(200, 1), note(201, 2), note(202, 6), note(203, 7)],
            },
          ],
        },
      ],
    };
    // Line 11 appears 0.5 s before its first note: pasted at 4 s, at 3.5 s.
    const before = setup(wide);
    before.paste(clipOf(chart, [103, 104], [10]), 4);
    expect(lines(before.doc.chart())).toEqual([
      { notes: 2, at: 3.5 },
      { notes: 4, at: null },
    ]);
    // Line 10 gives way 0.4 s after its last note ends: pasted at 3 s, at 4.5 s.
    const after = setup(wide);
    after.paste(clipOf(chart, [100, 101, 102], [10]), 3);
    expect(lines(after.doc.chart())).toEqual([
      { notes: 5, at: expect.closeTo(4.5, 9) },
      { notes: 2, at: null },
    ]);
    // Without them selected, the notes only join the line.
    const neither = setup(wide);
    neither.paste(clipOf(chart, [100, 101, 102]), 3);
    expect(lines(neither.doc.chart())).toEqual([{ notes: 7, at: null }]);
    for (const value of [before, after, neither]) expect(problems(value.doc.chart())).toEqual([]);
  });

  it("keeps the chart's own break where a copied one meets it with no notes between them", () => {
    const three: EditorChart = {
      ...chart,
      singers: [
        {
          ...chart.singers[0]!,
          lines: [
            ...chart.singers[0]!.lines,
            { id: 12, switchStart: null, switchEnd: null, notes: [note(105, 9, "on")] },
          ],
        },
      ],
    };
    const { paste, doc } = setup(three);
    // The copied break before "on and" would be at 5.5 s; line 11's default one is at 5.8 s: that one stays, and the
    // pasted notes join line 12.
    paste(clipOf(three, [103, 104], [10]), 6);
    expect(lines(doc.chart())).toEqual([
      { notes: 3, at: 2.5 },
      { notes: 2, at: null },
      { notes: 3, at: null },
    ]);
  });

  it("writes only the lines whose break changed", async () => {
    // Line 10's switch is stored with an end, line 11's outside its gap (after line 12 starts): both stay as they are.
    const kept: EditorChart = {
      ...chart,
      singers: [
        {
          ...chart.singers[0]!,
          lines: [
            { ...chart.singers[0]!.lines[0]!, switchStart: 2.5, switchEnd: 2.8 },
            { ...chart.singers[0]!.lines[1]!, switchStart: 9 },
            { id: 12, switchStart: null, switchEnd: null, notes: [note(105, 6, "on")] },
          ],
        },
      ],
    };
    const { paste, doc, saved } = setup(kept);
    paste(clipOf(chart, [100]), 7);
    await doc.saved();
    expect(saved[0]!.filter((change) => change.table === "line")).toEqual([]);
  });

  it("keeps a copied break after the notes out of a note there", () => {
    // "on" (5.1–7.1 s) starts among the pasted notes and reaches past them; the copied break would be inside it.
    const wide: EditorChart = {
      ...chart,
      singers: [
        {
          ...chart.singers[0]!,
          lines: [{ id: 20, switchStart: null, switchEnd: null, notes: [note(200, 1), note(201, 5.1, "on", 2)] }],
        },
      ],
    };
    const { paste, doc } = setup(wide);
    // Line 10 (1–2.1 s) and its break 0.4 s after: pasted at 4 s, that is 5.5 s.
    paste(clipOf(chart, [100, 101, 102], [10]), 4);
    expect(problems(doc.chart())).toEqual([]);
    const switches = doc.chart().singers[0]!.lines.map((line) => line.switchStart);
    expect(switches.every((time) => time === null || time <= 5.1 + 1e-9 || time >= 7.1 - 1e-9)).toBe(true);
  });

  it("leaves a default break among the pasted notes where it is when moving it would take a note to another line", () => {
    // A 1–10 s (its default break at 12 s), B 14–15 s (at 17 s), C 20–30 s; one long note pasted over 13–40 s.
    const three: EditorChart = {
      ...chart,
      singers: [
        {
          ...chart.singers[0]!,
          lines: [
            { id: 1, switchStart: null, switchEnd: null, notes: [note(1, 1, "a", 9)] },
            { id: 2, switchStart: null, switchEnd: null, notes: [note(2, 14, "b", 1)] },
            { id: 3, switchStart: null, switchEnd: null, notes: [note(3, 20, "c", 10)] },
          ],
        },
      ],
    };
    const long: Clip = {
      notes: [{ offset: 0, duration: 27, pitch: 60, lyric: "la", type: "normal" }],
      breaks: [],
      text: "la",
    };
    const { paste, doc } = setup(three);
    paste(long, 13, 50);
    // B keeps its note, the pasted one (from 13 s, after A's break) joining it.
    expect(lines(doc.chart()).map((line) => line.notes)).toEqual([1, 2, 1]);
  });

  it("puts a copied break right after the pasted notes after them, also inside notes there", () => {
    // The pasted note is 5–6 s, "on" 5.5–7 s overlaps it, then a note at 9 s; the copied break is at the pasted
    // note's end.
    const wide: EditorChart = {
      ...chart,
      singers: [
        {
          ...chart.singers[0]!,
          lines: [
            {
              id: 20,
              switchStart: null,
              switchEnd: null,
              notes: [note(200, 1), note(201, 5.5, "on", 1.5), note(202, 9)],
            },
          ],
        },
      ],
    };
    const clip: Clip = {
      notes: [{ offset: 0, duration: 1, pitch: 60, lyric: "la", type: "normal" }],
      breaks: [1],
      text: "la",
    };
    const { paste, doc } = setup(wide);
    paste(clip, 5);
    // After both: the pasted note stays in the line before.
    const [first] = doc.chart().singers[0]!.lines;
    expect(first!.notes.map((item) => item.start)).toEqual([1, 5, 5.5]);
    expect(first!.switchStart).toBeCloseTo(7, 9);
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
    paste(clipOf(chart, [100, 101, 102, 103, 104], [10]), 2);
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
