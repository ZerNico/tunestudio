/**
 * What the finished chart gets beyond the PoC's `build_song` (which `finishLines` reproduces): a beat between notes, as
 * usdb_syncer makes it on download, and a held syllable's closing consonants on its last held note, where charters
 * put them.
 */
import type { Note } from "./notes";
import { nuclei } from "./syllables";

/** Languages whose spelling says where a sung vowel ends; others keep "Hand ~". */
const VOWEL_SPLIT = new Set(["german"]);

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

/** A syllable as its leading space, its letters and what follows them (punctuation, the space). */
const SYLLABLE = /^(\s*)(.*?)([^\p{L}]*)$/su;

/**
 * Moves a held syllable's closing consonants onto its last held note (in place): "Hand," on two notes becomes "Ha" and
 * "~nd,", nearer to what is sung (the vowel is held, the consonants come at the end). Only in `language`s whose
 * spelling says where the vowel ends.
 */
export function codaOnHold(lines: Note[][], language: string): void {
  if (!VOWEL_SPLIT.has(language)) return;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const first = line[i]!;
      if (first.text.trim().startsWith("~")) continue;
      let last = i;
      while (line[last + 1]?.text.trim() === "~") last++;
      if (last === i) continue;
      const [, lead, letters, after] = SYLLABLE.exec(first.text)!;
      const chars = [...letters!];
      const end = nuclei(
        chars.map((char) => char.toLowerCase()),
        language,
      ).at(-1)?.[1];
      // Nothing after the vowel to move, or no vowel to hold.
      if (end === undefined || end === chars.length) continue;
      const hold = line[last]!;
      const space = /\s$/.test(after!) || /\s$/.test(hold.text) ? " " : "";
      first.text = `${lead}${chars.slice(0, end).join("")}`;
      hold.text = `~${chars.slice(end).join("")}${after!.trimEnd()}${space}`;
      i = last;
    }
  }
}
