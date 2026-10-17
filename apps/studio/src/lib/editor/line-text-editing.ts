/**
 * Editing a line's lyrics as text, as the lyrics lane's field does (`line-text.ts` has the rules): which line is being
 * edited with its text, and applying what was typed as one edit. Words typed whole are split into syllables first
 * (main knows how), so applying waits a moment: meanwhile Esc cancels it, and another line's field opened stays open.
 * A text Enter couldn't apply stays to be fixed; one applied by leaving the field is dropped with the message.
 */
import { createSignal } from "solid-js";

import type { EditorChart } from "~/lib/native/types";

import type { ChartDocument } from "./document";
import { applyLineText, lineText, wordsToSplit } from "./line-text";

/** A line being edited, and its text. */
export interface EditedLine {
  lineId: number;
  text: string;
}

export function createLineTextEditing<Selection>(options: {
  doc: () => ChartDocument<Selection>;
  chart: () => EditorChart;
  /** Splits words into syllables, in the song's language. */
  syllabify: (words: string[]) => Promise<readonly (readonly string[])[]>;
  /** A text was refused: why. */
  onRefused: (message: string) => void;
  onError: (error: unknown) => void;
  /** A field is about to open: other gestures stop. */
  beforeEdit?: () => void;
}) {
  const [editing, setEditing] = createSignal<EditedLine | null>(null);
  /** The texts being applied, by line, until they are (or Esc cancels them). */
  const applying = new Map<number, EditedLine>();

  return {
    editing,

    /** Opens the field of line `lineId`. */
    edit(lineId: number) {
      const line = options
        .chart()
        .singers.flatMap((singer) => singer.lines)
        .find((item) => item.id === lineId);
      if (!line || line.notes.length === 0) return;
      options.beforeEdit?.();
      setEditing({ lineId, text: lineText(line.notes.toSorted((a, b) => a.start - b.start)) });
    },

    /** The field was left (`fromKey`: with Enter) with `text`, or cancelled (null). */
    async finish(text: string | null, fromKey: boolean) {
      const opened = editing();
      if (text === null) {
        if (opened) applying.delete(opened.lineId);
        return void setEditing(null);
      }
      if (!opened || applying.has(opened.lineId)) return;
      if (text === opened.text) return void setEditing(null);
      const mine: EditedLine = { lineId: opened.lineId, text };
      applying.set(mine.lineId, mine);
      try {
        const words = wordsToSplit(text);
        const splits = words.length > 0 ? await options.syllabify(words) : [];
        if (applying.get(mine.lineId) !== mine) return;
        const known = new Map(words.map((word, i) => [word, splits[i] ?? [word]]));
        const chart = options.chart();
        const problem = options
          .doc()
          .tryEdit("Edit line lyrics", (tx) =>
            applyLineText(tx, chart, mine.lineId, text, (word) => known.get(word) ?? [word]),
          );
        if (problem) options.onRefused(problem);
        // Another line's field opened meanwhile stays open.
        if (editing() === opened) setEditing(problem && fromKey ? mine : null);
      } catch (error) {
        options.onError(error);
        if (editing() === opened) setEditing(null);
      } finally {
        if (applying.get(mine.lineId) === mine) applying.delete(mine.lineId);
      }
    },
  };
}
