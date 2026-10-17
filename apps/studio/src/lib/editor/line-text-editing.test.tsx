import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type { EditorChart } from "~/lib/native/types";

import { createChartDocument } from "./document";
import { createLineTextEditing } from "./line-text-editing";
import { testNote as note, testSong } from "./test-chart";

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
        { id: 10, switchStart: null, switchEnd: null, notes: [note(100, 1, "Hel"), note(101, 1.5, "lo ")] },
        { id: 11, switchStart: null, switchEnd: null, notes: [note(102, 3, "world")] },
      ],
    },
  ],
};

function setup() {
  const doc = createRoot(() => {
    const [selection, setSelection] = createSignal<number[]>([]);
    return createChartDocument<number[]>({ chart, save: async () => {}, onFailed: () => {}, selection, setSelection });
  });
  /** Syllables arrive when the test says. */
  let answer: (() => void) | undefined;
  const syllabify = vi.fn(
    (words: string[]) => new Promise<string[][]>((resolve) => (answer = () => resolve(words.map((word) => [word])))),
  );
  const onRefused = vi.fn();
  const lines = createRoot(() =>
    createLineTextEditing({ doc: () => doc, chart: () => doc.chart(), syllabify, onRefused, onError: vi.fn() }),
  );
  const lyrics = () => doc.chart().singers[0]!.lines.flatMap((line) => line.notes.map((item) => item.lyric));
  return { doc, lines, lyrics, answer: () => answer?.(), onRefused };
}

describe("editing a line's lyrics as text", () => {
  it("opens with the line's text and applies what was typed as one edit", async () => {
    const { doc, lines, lyrics, answer } = setup();
    lines.edit(10);
    flush();
    expect(lines.editing()).toEqual({ lineId: 10, text: "Hel-lo" });
    const done = lines.finish("Hel-lo there", true);
    answer();
    await done;
    flush();
    expect(lines.editing()).toEqual({ lineId: 10, text: "Hel-lo there" });
    // "there" has no notes: refused, the text stays to be fixed.
    expect(doc.undoLabel()).toBeNull();
    const again = lines.finish("Hal-lo", true);
    answer();
    await again;
    flush();
    expect(lyrics()).toEqual(["Hal", "lo ", "world"]);
    expect(lines.editing()).toBeNull();
    expect(doc.undoLabel()).toBe("Edit line lyrics");
  });

  it("drops a text Esc cancelled while it waited, and leaves another line's field open", async () => {
    // A word typed whole waits for its syllables.
    const { doc, lines, lyrics, answer } = setup();
    lines.edit(11);
    flush();
    const cancelled = lines.finish("earth", false);
    void lines.finish(null, true);
    answer();
    await cancelled;
    flush();
    expect(lyrics()).toEqual(["Hel", "lo ", "world"]);
    expect(doc.undoLabel()).toBeNull();

    lines.edit(11);
    flush();
    const applied = lines.finish("earth", false);
    lines.edit(10);
    answer();
    await applied;
    flush();
    expect(lyrics()).toEqual(["Hel", "lo ", "earth"]);
    expect(lines.editing()).toEqual({ lineId: 10, text: "Hel-lo" });
  });
});
