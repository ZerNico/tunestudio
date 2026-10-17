/**
 * Which singer is active (new notes, paste, line breaks and Chart range go to them) and which are hidden, in a duet.
 * Both are views of the chart, not part of it: nothing here is saved, exported or undone.
 */
import { createEffect, createMemo, createSignal, untrack } from "solid-js";

import type { EditorChart } from "~/lib/native/types";

export type SingerIndex = 1 | 2;

export function createSingersView(chart: () => EditorChart) {
  const [chosen, setChosen] = createSignal<SingerIndex>(1);
  const [hiddenSet, setHiddenSet] = createSignal<ReadonlySet<SingerIndex>>(new Set());

  /** The hidden singers that exist; never every singer, and none in a solo chart. */
  const hidden = createMemo<ReadonlySet<SingerIndex>>(() => {
    const singers = chart().singers;
    if (singers.length < 2) return new Set();
    const present = singers.filter((singer) => hiddenSet().has(singer.index)).map((singer) => singer.index);
    return new Set(present.length < singers.length ? present : []);
  });
  // A singer added (or brought back by undo or redo) is shown: what was hidden was hidden for the duet as it was.
  let count = untrack(() => chart().singers.length);
  createEffect(
    () => chart().singers.length,
    (next) => {
      if (next > count) setHiddenSet(new Set<SingerIndex>());
      count = next;
    },
  );
  /** The chosen singer when it exists and is shown, else the first shown one. */
  const index = createMemo<SingerIndex>(() => {
    const shown = chart().singers.filter((singer) => !hidden().has(singer.index));
    return (shown.find((singer) => singer.index === chosen()) ?? shown[0])?.index ?? 1;
  });

  return {
    /** The active singer: 1 or 2 (P1, P2). */
    index,
    /** Its row id (null: the chart has no singer). */
    id: () => chart().singers.find((singer) => singer.index === index())?.id ?? null,
    /** Makes a singer active, showing it if it was hidden. */
    choose(singer: number) {
      const next: SingerIndex = singer === 2 ? 2 : 1;
      setChosen(next);
      if (hiddenSet().has(next)) setHiddenSet(new Set([...hiddenSet()].filter((item) => item !== next)));
    },
    isHidden: (singer: number) => hidden().has(singer as SingerIndex),
    /** Hides or shows a singer. The last one shown can't be hidden; hiding the active one makes the other active. */
    setHidden(singer: SingerIndex, hide: boolean) {
      const next = new Set(hiddenSet());
      if (hide) next.add(singer);
      else next.delete(singer);
      const singers = chart().singers;
      if (hide && singers.every((item) => item.index === singer || next.has(item.index))) return;
      setHiddenSet(next);
      if (hide && index() === singer) {
        const other = singers.find((item) => !next.has(item.index));
        if (other) setChosen(other.index);
      }
    },
    /** Shows only this singer, and makes it active. */
    solo(singer: SingerIndex) {
      setHiddenSet(
        new Set<SingerIndex>(
          chart()
            .singers.map((item) => item.index)
            .filter((item) => item !== singer),
        ),
      );
      setChosen(singer);
    },
    showAll: () => setHiddenSet(new Set<SingerIndex>()),
  };
}

export type SingersView = ReturnType<typeof createSingersView>;
