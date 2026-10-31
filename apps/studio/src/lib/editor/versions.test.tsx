import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";

import type { ChartChange } from "~/lib/native/contract";
import type { EditorChart } from "~/lib/native/types";

import { createChartDocument } from "./document";
import { testNote, testSong } from "./test-chart";
import { restoreVersion, sameAsVersion } from "./versions";

const duet = (): EditorChart => ({
  bpm: 300,
  gap: 0,
  song: testSong,
  singers: [
    {
      id: 1,
      index: 1,
      name: "Anna",
      lines: [
        { id: 10, switchStart: 2.5, switchEnd: null, notes: [testNote(100, 1, "one "), testNote(101, 1.5, "two")] },
        { id: 11, switchStart: null, switchEnd: null, notes: [testNote(102, 3, "three")] },
      ],
    },
    {
      id: 2,
      index: 2,
      name: "Ben",
      lines: [{ id: 20, switchStart: null, switchEnd: null, notes: [testNote(200, 8, "late")] }],
    },
  ],
});

/** A solo version from earlier: other notes, a name, another gap and title, and a note that wasn't changed by hand. */
const solo = (): EditorChart => ({
  bpm: 300,
  gap: 0.5,
  song: { ...testSong, title: "Earlier title" },
  singers: [
    {
      id: 7,
      index: 1,
      name: null,
      lines: [
        {
          id: 70,
          switchStart: null,
          switchEnd: null,
          notes: [{ ...testNote(700, 2, "first "), edited: false }, testNote(701, 2.5, "draft")],
        },
      ],
    },
  ],
});

/** The chart without row ids, which a restore gives new ones. */
const withoutIds = (chart: EditorChart) => ({
  ...chart,
  singers: chart.singers.map(({ id: _id, ...singer }) => ({
    ...singer,
    lines: singer.lines.map(({ id: _line, ...line }) => ({
      ...line,
      notes: line.notes.map(({ id: _note, ...note }) => note),
    })),
  })),
});

function setup(chart: EditorChart) {
  return createRoot(() => {
    const saved: { changes: ChartChange[]; label: string; keepVersion?: boolean }[] = [];
    const doc = createChartDocument<number[]>({
      chart,
      save: async (changes, edit) => void saved.push({ changes, ...edit }),
      onFailed: () => {},
      selection: () => [],
      setSelection: () => {},
    });
    const restore = (version: EditorChart) => {
      doc.edit("Restore version", (tx) => restoreVersion(tx, doc.chart(), version), { keepVersion: true });
      flush();
    };
    return { doc, restore, saved };
  });
}

describe("restoreVersion", () => {
  it("makes the chart the version's in one edit that keeps a version first, and undoes back exactly", async () => {
    const current = duet();
    const { doc, restore, saved } = setup(current);
    restore(solo());
    expect(withoutIds(doc.chart())).toEqual(withoutIds(solo()));
    await doc.saved();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ label: "Restore version", keepVersion: true });
    // The singer P1 keeps its row; P2 is gone.
    expect(doc.chart().singers.map((singer) => singer.id)).toEqual([1]);

    doc.undo();
    flush();
    expect(doc.chart()).toEqual(current);
    await doc.saved();
    expect(saved.at(-1)).toMatchObject({ label: "Undo Restore version" });
  });

  it("brings back a second singer the chart no longer has", () => {
    const { doc, restore } = setup(solo());
    restore(duet());
    expect(withoutIds(doc.chart())).toEqual(withoutIds(duet()));
  });
});

describe("sameAsVersion", () => {
  it("compares what a restore would set, not row ids, key order or the other headers", () => {
    const current = duet();
    const decoded: EditorChart = JSON.parse(JSON.stringify(withoutIds(current)), (_key, value) =>
      // As read back: other ids, keys in another order, headers a version doesn't set.
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    );
    const version = {
      ...decoded,
      song: { ...decoded.song, otherHeaders: [["COMMENT", "old"] as const] },
      singers: decoded.singers.map((singer, index) => ({
        ...singer,
        id: 90 + index,
        lines: singer.lines.map((line, lineIndex) => ({
          ...line,
          id: 900 + lineIndex,
          notes: line.notes.map((note, noteIndex) => ({ ...note, id: 9000 + noteIndex })),
        })),
      })),
    };
    expect(sameAsVersion(current, version)).toBe(true);
    expect(sameAsVersion(current, { ...version, gap: 1 })).toBe(false);
    expect(sameAsVersion(current, solo())).toBe(false);
  });
});
