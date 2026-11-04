/**
 * What the finished chart gets beyond the PoC's `build_song` (which `finishLines` reproduces): a beat between notes, as
 * usdb_syncer makes it on download.
 */
import type { Note } from "./notes";

/**
 * Shortens every note that touches the next one (in place), so a beat lies between them: usdb_syncer shortens them on
 * download (`fix_overlapping_and_touching_notes`), so the chart reads the same before. A one-beat note stays.
 */
export function keepNotesApart(lines: Note[][]): void {
  const notes = lines.flat();
  for (let i = 0; i + 1 < notes.length; i++) {
    const [a, b] = [notes[i]!, notes[i + 1]!];
    if (a.start + a.length >= b.start) a.length = Math.max(1, b.start - a.start - 1);
  }
}
