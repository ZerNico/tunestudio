/**
 * Restoring a version of the chart (`electron/project/versions.ts` keeps them): one edit that makes the chart the
 * version's, so undo takes it back. Singers are matched by P1/P2 and keep their rows; every line and note is replaced.
 */
import type { EditorChart } from "~/lib/native/types";

import type { EditRecorder } from "./document";

/** Makes `current` (the chart as the editor has it) into `version`. */
export function restoreVersion(tx: EditRecorder, current: EditorChart, version: EditorChart) {
  for (const singer of current.singers) {
    for (const line of singer.lines) {
      for (const note of line.notes) tx.deleteNote(note.id);
      tx.deleteLine(line.id);
    }
  }
  // A singer the version doesn't have goes once its lines have; the version's are matched by index, which is unique.
  const singerIds = new Map<number, number>();
  for (const singer of current.singers) {
    if (version.singers.some((kept) => kept.index === singer.index)) singerIds.set(singer.index, singer.id);
    else tx.deleteSinger(singer.id);
  }
  for (const singer of version.singers) {
    const id = singerIds.get(singer.index);
    if (id === undefined) singerIds.set(singer.index, tx.createSinger({ index: singer.index, name: singer.name }));
    else tx.updateSinger(id, { name: singer.name });
  }
  for (const singer of version.singers) {
    const singerId = singerIds.get(singer.index)!;
    for (const line of singer.lines) {
      const lineId = tx.createLine({ singerId, switchStart: line.switchStart, switchEnd: line.switchEnd });
      for (const { id: _id, ...note } of line.notes) tx.createNote({ ...note, lineId });
    }
  }
  // The headers it came with (`otherHeaders`) aren't edited, so they are the same in every version.
  const { otherHeaders: _otherHeaders, ...song } = version.song;
  tx.updateSong({ ...song, bpm: version.bpm, gap: version.gap });
}

/** The chart's content, without row ids (a restore gives new ones) or the headers a version doesn't set. */
function content(chart: EditorChart) {
  const { otherHeaders: _otherHeaders, ...song } = chart.song;
  // Keys sorted: the editor's rows and a decoded version needn't list them in the same order.
  const sorted = (_key: string, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value;
  return JSON.stringify(
    {
      bpm: chart.bpm,
      gap: chart.gap,
      song,
      singers: chart.singers.map((singer) => ({
        index: singer.index,
        name: singer.name,
        lines: singer.lines.map(({ id: _line, notes, ...line }) => ({
          ...line,
          notes: notes.map(({ id: _note, ...note }) => note),
        })),
      })),
    },
    sorted,
  );
}

/** Whether restoring `version` would leave `current` as it is. */
export function sameAsVersion(current: EditorChart, version: EditorChart) {
  return content(current) === content(version);
}
