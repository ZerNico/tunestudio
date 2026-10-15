import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type { ChartChange } from "~/lib/native/contract";
import type { EditorChart } from "~/lib/native/types";

import { chartFromRows, createChartDocument, rowsFromChart } from "./document";
import { testSong } from "./test-song";

const note = (id: number, start: number, lyric: string) => ({
  id,
  start,
  duration: 0.3,
  pitch: 64,
  lyric,
  type: "normal" as const,
  edited: false,
});

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
        { id: 10, switchStart: null, switchEnd: null, notes: [note(100, 1, "We "), note(101, 1.5, "walk")] },
        { id: 11, switchStart: null, switchEnd: null, notes: [note(102, 3, "on")] },
      ],
    },
  ],
};

/** A document over the chart with a fake save, in a root like the editor screen. */
function setup(save = vi.fn(async (_changes: ChartChange[]) => {})) {
  const onFailed = vi.fn();
  return createRoot(() => {
    const [selection, setSelection] = createSignal<number[]>([]);
    const doc = createChartDocument<number[]>({ chart, save, onFailed, selection, setSelection });
    return { doc, save, onFailed, selection, setSelection };
  });
}

const lyrics = (value: EditorChart) => value.singers[0]!.lines.map((line) => line.notes.map((n) => n.lyric).join(""));

describe("chart rows", () => {
  it("turn into the tree and back unchanged", () => {
    expect(chartFromRows(rowsFromChart(chart))).toEqual(chart);
  });
});

describe("chart document", () => {
  it("applies an edit at once, saves it, and undoes and redoes it, restoring the selection", async () => {
    const { doc, save, selection, setSelection } = setup();
    setSelection([100]);
    flush();
    doc.edit("Move note", (tx) => tx.updateNote(101, { start: 3.5, pitch: 66 }), { selection: [101] });
    flush();
    expect(lyrics(doc.chart())).toEqual(["We walk", "on"]);
    expect(doc.chart().singers[0]!.lines[0]!.notes[1]).toMatchObject({ start: 3.5, pitch: 66, edited: true });
    expect(selection()).toEqual([101]);
    expect(doc.undoLabel()).toBe("Move note");

    doc.undo();
    flush();
    expect(doc.chart()).toEqual(chart);
    expect(selection()).toEqual([100]);
    expect(doc.redoLabel()).toBe("Move note");
    doc.redo();
    flush();
    expect(doc.chart().singers[0]!.lines[0]!.notes[1]!.start).toBe(3.5);
    await doc.saved();
    // The edit, its undo (before and after swapped), and the redo, in that order.
    const sent = save.mock.calls.map(([changes]) => changes);
    expect(sent).toHaveLength(3);
    expect(sent[1]![0]).toMatchObject({ id: 101, before: { start: 3.5 }, after: { start: 1.5, edited: false } });
  });

  it("builds an edit from several changes that see each other: split a line into a new one", async () => {
    const { doc, save } = setup();
    doc.edit("Split line", (tx) => {
      const line = tx.createLine({ singerId: 1, switchStart: null, switchEnd: null });
      tx.updateNote(101, { lineId: line });
      expect(tx.note(101)?.lineId).toBe(line);
    });
    flush();
    expect(lyrics(doc.chart())).toEqual(["We ", "walk", "on"]);
    // New rows get ids above every existing one.
    await doc.saved();
    const created = save.mock.calls[0]![0]![0]!;
    expect(created).toMatchObject({ table: "line", before: null });
    expect((created as { id: number }).id).toBeGreaterThan(102);
    // An edit that changes nothing isn't a step.
    expect(doc.edit("Nothing", (tx) => tx.updateNote(100, { start: 1, edited: false }))).toBe(false);
    expect(doc.undoLabel()).toBe("Split line");
  });

  it("changes song details as part of the same history", () => {
    const { doc } = setup();
    doc.edit("Change BPM", (tx) => tx.updateSong({ bpm: 600 }));
    flush();
    expect(doc.chart().bpm).toBe(600);
    doc.undo();
    flush();
    expect(doc.chart().bpm).toBe(300);
  });

  it("drops the history and reports when saving fails, and edits nothing more", async () => {
    const save = vi.fn(async () => {
      throw new Error("The disk is full.");
    });
    const { doc, onFailed } = setup(save);
    doc.edit("Delete note", (tx) => tx.deleteNote(102));
    await doc.saved();
    expect(onFailed).toHaveBeenCalledWith(new Error("The disk is full."));
    expect(doc.undoLabel()).toBeNull();
    expect(doc.edit("Delete another", (tx) => tx.deleteNote(100))).toBe(false);
  });

  it("changes song details and a singer's name as edits, saved with what they were and undone", async () => {
    const { doc, save } = setup();
    doc.edit("Change title", (tx) => tx.updateSong({ title: "Day Signals", tags: ["live"] }));
    doc.edit("Change singer's name", (tx) => tx.updateSinger(1, "Mia"));
    // The same again changes nothing.
    expect(doc.edit("Change title", (tx) => tx.updateSong({ title: "Day Signals" }))).toBe(false);
    flush();
    expect(doc.chart().song).toMatchObject({ title: "Day Signals", tags: ["live"], artist: "Test Artist" });
    expect(doc.chart().singers[0]!.name).toBe("Mia");
    await doc.saved();
    expect(save.mock.calls.map(([changes]) => changes)).toEqual([
      [
        {
          table: "song",
          before: { title: "Night Signals", tags: [] },
          after: { title: "Day Signals", tags: ["live"] },
        },
      ],
      [{ table: "singer", id: 1, before: { name: null }, after: { name: "Mia" } }],
    ]);
    doc.undo();
    doc.undo();
    flush();
    expect(doc.chart().song.title).toBe("Night Signals");
    expect(doc.chart().singers[0]!.name).toBeNull();
  });
});
