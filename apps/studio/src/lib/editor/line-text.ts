/**
 * A line's lyrics as text, edited as a whole and matched back onto its notes. The text has the line's words with
 * spaces between them and `-` between a word's syllables (one per note, `~` for a held note, `\-` and `\ ` for a hyphen
 * or space that is part of a syllable), as Yass and Karedi show it: "Dei-ne Hand zum Grei-fen nah,-~". A note without a
 * syllable yet (drawn) is a word of its own, shown as nothing between spaces, for the word typed there.
 *
 * Applying it goes word by word, so a change stays where it was made: words that are still there are left as they are
 * (unless typed with another syllable split); between them, changed words take over the old words' notes. More
 * syllables than notes split the longest notes; fewer leave the rest as held notes (`~`), after splitting words typed
 * without `-` into syllables (`Syllables`). Words that are gone lose their notes (notes still without a syllable stay,
 * and are only taken by words that need them). Words moved within the line take the line's notes in order. New words
 * with no notes to take over are refused before anything changes: there is nothing to place them on.
 */
import type { EditorChart } from "~/lib/native/types";

import { gridStep, onGrid } from "./chart";
import type { EditRecorder } from "./document";
import { splitNote } from "./edits";

const HOLD = "~";

/** Splits typed words (without `-`) into syllables; a word it doesn't know stays whole. */
export type Syllables = (word: string) => readonly string[];

/** A word: its syllables (one per note) and what it says (the syllables without held notes). */
interface Word {
  pieces: string[];
  text: string;
}

const textOf = (pieces: readonly string[]) => pieces.filter((piece) => piece !== HOLD).join("");
const escape = (piece: string) => piece.replace(/[\\\- ]/g, (char) => `\\${char}`);

/** Where lyrics put the spaces between words: before a word (" world"), after it ("world "), or unknown. */
function spaceStyle(lyrics: readonly string[]): "leading" | "trailing" | null {
  if (lyrics.slice(0, -1).some((lyric) => /\s$/.test(lyric))) return "trailing";
  if (lyrics.slice(1).some((lyric) => /^\s/.test(lyric))) return "leading";
  return null;
}

/**
 * The notes' lyrics as words: a word ends at a space (after a syllable, or before the next), and around a note without
 * a syllable.
 */
function wordsOf(lyrics: readonly string[]): { pieces: string[]; size: number }[] {
  const words: { pieces: string[]; size: number }[] = [];
  lyrics.forEach((lyric, i) => {
    const piece = lyric.trim();
    const previous = lyrics[i - 1];
    const starts =
      previous === undefined ||
      piece === "" ||
      previous.trim() === "" ||
      /\s$/.test(previous) ||
      (/^\s/.test(lyric) && piece !== HOLD);
    if (starts) words.push({ pieces: [], size: 0 });
    const word = words.at(-1)!;
    word.pieces.push(piece);
    word.size++;
  });
  return words;
}

/** The line's lyrics as text. */
export function lineText(notes: readonly { lyric: string }[]): string {
  return wordsOf(notes.map((note) => note.lyric))
    .map((word) => word.pieces.map(escape).join("-"))
    .join(" ");
}

/** The typed text as words. */
export function parseLineText(text: string): Word[] {
  const words: Word[] = [];
  let pieces: string[] = [];
  let piece = "";
  const endPiece = () => {
    if (piece) pieces.push(piece);
    piece = "";
  };
  const endWord = () => {
    endPiece();
    if (pieces.length > 0) words.push({ pieces, text: textOf(pieces) });
    pieces = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    // An escaped space or hyphen is part of the syllable.
    if (char === "\\" && i + 1 < text.length) piece += text[++i];
    else if (/\s/.test(char)) endWord();
    else if (char === "-") endPiece();
    else piece += char;
  }
  endWord();
  return words;
}

/** The words typed without `-` (for `Syllables`, worked out before applying). */
export function wordsToSplit(text: string): string[] {
  return [...new Set(parseLineText(text).flatMap((word) => (word.pieces.length === 1 ? [word.pieces[0]!] : [])))];
}

/** Pairs of equal words (old index, new index), longest common run. */
function matchWords(old: readonly string[], typed: readonly string[]): [number, number][] {
  const lengths = Array.from({ length: old.length + 1 }, () =>
    Array.from<number>({ length: typed.length + 1 }).fill(0),
  );
  for (let i = old.length - 1; i >= 0; i--)
    for (let j = typed.length - 1; j >= 0; j--)
      lengths[i]![j] =
        old[i] === typed[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < old.length && j < typed.length) {
    if (old[i] === typed[j]) pairs.push([i++, j++]);
    else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** A word's syllables split further toward `wanted` pieces, where it was typed as one and `syllables` knows it. */
function splitToFit(words: Word[], wanted: number, syllables: Syllables): Word[] {
  let missing = wanted - words.reduce((sum, word) => sum + word.pieces.length, 0);
  return words.map((word) => {
    if (missing <= 0 || word.pieces.length !== 1 || word.pieces[0] === HOLD) return word;
    const parts = syllables(word.pieces[0]!).filter(Boolean);
    if (parts.length < 2 || parts.join("") !== word.pieces[0]) return word;
    // Too many syllables: the shortest neighbours join.
    while (parts.length - 1 > missing) {
      let best = 0;
      for (let k = 1; k < parts.length - 1; k++)
        if (parts[k]!.length + parts[k + 1]!.length < parts[best]!.length + parts[best + 1]!.length) best = k;
      parts.splice(best, 2, parts[best]! + parts[best + 1]!);
    }
    missing -= parts.length - 1;
    return { pieces: parts, text: word.text };
  });
}

/**
 * Puts the typed `text` on the line `lineId` as one edit (see the module's comment). Returns why it can't, or null.
 */
export function applyLineText(
  tx: EditRecorder,
  chart: EditorChart,
  lineId: number,
  text: string,
  syllables: Syllables = (word) => [word],
): string | null {
  const line = chart.singers.flatMap((singer) => singer.lines).find((item) => item.id === lineId);
  if (!line || line.notes.length === 0) return "That line is gone.";
  const typed = parseLineText(text);
  // Held notes alone aren't lyrics.
  if (typed.every((word) => word.text === "")) return "Type the line's lyrics, or delete its notes.";
  const notes = line.notes.toSorted((a, b) => a.start - b.start);
  const lyrics = notes.map((note) => note.lyric);
  // The line's own style, else the chart's (a line of one word shows none).
  const style =
    spaceStyle(lyrics) ??
    chart.singers
      .flatMap((singer) => singer.lines)
      .map((item) => spaceStyle(item.notes.toSorted((a, b) => a.start - b.start).map((note) => note.lyric)))
      .find(Boolean);
  const leading = style === "leading";
  const endSpace = !leading && /\s$/.test(lyrics.at(-1)!);
  const startSpace = leading && /^\s/.test(lyrics[0]!);
  let at = 0;
  const old = wordsOf(lyrics).map((word) => {
    const ids = notes.slice(at, (at += word.size)).map((note) => note.id);
    return { ids, pieces: word.pieces, text: textOf(word.pieces) };
  });

  /** Runs of typed words with the notes they are sung on (at least one note per syllable once split). */
  let blocks: { ids: number[]; words: Word[] }[] = [];
  let deleted: number[] = [];
  let homeless: string[] = [];
  const fit = (from: typeof old, words: Word[]) => {
    const ids = from.flatMap((word) => word.ids);
    const pieces = words.reduce((sum, word) => sum + word.pieces.length, 0);
    // Notes still without a syllable are only taken when the words need them, and never deleted.
    const filled = from.filter((word) => word.text !== "").flatMap((word) => word.ids);
    if (words.length === 0) deleted.push(...filled);
    else if (ids.length === 0) homeless.push(...words.map((word) => word.text));
    // As many words as before: each takes its own word's notes.
    else if (from.length === words.length && from.length > 1) from.forEach((word, k) => fit([word], [words[k]!]));
    else {
      const taken = filled.length >= pieces ? filled : ids;
      blocks.push({ ids: taken, words: splitToFit(words, taken.length, syllables) });
    }
  };
  const pairs = matchWords(
    old.map((word) => word.text),
    typed.map((word) => word.text),
  );
  let oldAt = 0;
  let typedAt = 0;
  for (const [i, j] of [...pairs, [old.length, typed.length] as [number, number]]) {
    fit(old.slice(oldAt, i), typed.slice(typedAt, j));
    // The same word is left as it is (typed without its `-` too), unless it was split into syllables differently.
    if (i < old.length && typed[j]!.pieces.length > 1 && typed[j]!.pieces.join("-") !== old[i]!.pieces.join("-"))
      fit([old[i]!], [typed[j]!]);
    oldAt = i + 1;
    typedAt = j + 1;
  }
  // Words moved (or swapped for gone ones) rather than added: the whole line's notes go to the words in order.
  if (homeless.length > 0 && deleted.length > 0) {
    blocks = [];
    deleted = [];
    homeless = [];
    fit(old, typed);
  }
  if (homeless.length > 0)
    return `${homeless.map((word) => `“${word}”`).join(", ")} ${homeless.length === 1 ? "has" : "have"} no notes. Draw them first.`;

  // More syllables than notes: the longest notes are split in two until there are enough (checked before any change).
  const step = gridStep(chart);
  const steps = new Map(notes.map((note) => [note.id, Math.round(note.duration / step)]));
  for (const block of blocks) {
    const lengths = block.ids.map((id) => steps.get(id)!);
    const pieces = block.words.reduce((sum, word) => sum + word.pieces.length, 0);
    while (lengths.length < pieces) {
      const longest = Math.max(...lengths);
      if (longest < 2)
        return `“${block.words.map((word) => word.text).join(" ")}” has more syllables than its notes have room for.`;
      lengths.splice(lengths.indexOf(longest), 1, Math.ceil(longest / 2), Math.floor(longest / 2));
    }
  }
  for (const block of blocks) {
    const pieces = block.words.reduce((sum, word) => sum + word.pieces.length, 0);
    while (block.ids.length < pieces) {
      const longest = block.ids
        .map((id) => tx.note(id)!)
        .reduce((best, note) => (note.duration > best.duration ? note : best));
      const created = splitNote(tx, chart, longest.id, onGrid(chart, longest.start + longest.duration / 2));
      if (created === null) break;
      block.ids.splice(block.ids.indexOf(longest.id) + 1, 0, created);
    }
  }
  for (const id of deleted) tx.deleteNote(id);

  // Each word takes as many notes as it has syllables; the last of a run takes the rest, held.
  const firstNote = notes[0]!.id;
  const lastNote = notes.at(-1)!.id;
  for (const block of blocks) {
    const opens = block.ids[0] === firstNote;
    const closes = block.ids.includes(lastNote);
    let next = 0;
    block.words.forEach((word, k) => {
      const final = k === block.words.length - 1;
      const ids = block.ids.slice(next, (next = final ? block.ids.length : next + word.pieces.length));
      ids.forEach((id, n) => {
        let lyric = word.pieces[n] ?? HOLD;
        // Spaces between words: before each but the line's first (which keeps its own), or after each but its last.
        if (leading && n === 0 && (opens && k === 0 ? startSpace : true)) lyric = ` ${lyric}`;
        if (!leading && n === ids.length - 1 && (!(closes && final) || endSpace)) lyric = `${lyric} `;
        if (tx.note(id)?.lyric !== lyric) tx.updateNote(id, { lyric });
      });
    });
  }

  // The line's ends as they were, where a deleted word leaves another word there.
  const remaining = [...notes.map((note) => note.id), ...blocks.flatMap((block) => block.ids)]
    .filter((id, i, all) => !deleted.includes(id) && all.indexOf(id) === i)
    .map((id) => tx.note(id)!)
    .toSorted((a, b) => a.start - b.start);
  const first = remaining[0];
  const last = remaining.at(-1);
  if (first && first.lyric.trim() && /^\s/.test(first.lyric) !== startSpace)
    tx.updateNote(first.id, { lyric: startSpace ? ` ${first.lyric.trimStart()}` : first.lyric.trimStart() });
  if (!leading && last && last.lyric.trim() && /\s$/.test(last.lyric) !== endSpace)
    tx.updateNote(last.id, { lyric: endSpace ? `${last.lyric.trimEnd()} ` : last.lyric.trimEnd() });
  return null;
}
