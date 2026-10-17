/**
 * Splitting lyric words into sung syllables the way UltraStar charters do: the split learned from hand-made charts
 * where the word is known (`data/syllables-<language>.json`), vowel-group rules otherwise. A port of the auto-tuner
 * PoC's `syllables.py` / `lyrics.syllabify`; tests check it against the PoC's output word for word.
 *
 * Strings are handled as code points, like Python's: an emoji or other character outside the BMP counts once.
 */
import english from "./data/syllables-english.json";
import german from "./data/syllables-german.json";

const VOWELS: Record<string, string> = {
  english: "aeiouy",
  german: "aeiouyäöü",
};

/** Letter groups that are one vowel sound, longest first. */
const DIGRAPHS: Record<string, string[]> = {
  english: byLength([
    "eau",
    "ai",
    "au",
    "aw",
    "ay",
    "ea",
    "ee",
    "ei",
    "eu",
    "ew",
    "ey",
    "ie",
    "oa",
    "oe",
    "oi",
    "oo",
    "ou",
    "ow",
    "oy",
    "ue",
    "ui",
  ]),
  german: byLength(["aa", "ai", "au", "äu", "ee", "ei", "eu", "ie", "oo", "ui"]),
};

/** Consonant groups that stay together and start the next syllable, longest first. */
const ONSETS: Record<string, string[]> = {
  english: byLength([
    "sch",
    "chr",
    "thr",
    "shr",
    "spr",
    "str",
    "scr",
    "ch",
    "sh",
    "th",
    "ph",
    "wh",
    "ck",
    "qu",
    "bl",
    "br",
    "cl",
    "cr",
    "dr",
    "fl",
    "fr",
    "gl",
    "gr",
    "pl",
    "pr",
    "sc",
    "sk",
    "sl",
    "sm",
    "sn",
    "sp",
    "st",
    "sw",
    "tr",
    "tw",
  ]),
  german: byLength([
    "schr",
    "sch",
    "chr",
    "pf",
    "ch",
    "ck",
    "qu",
    "st",
    "sp",
    "bl",
    "br",
    "dr",
    "fl",
    "fr",
    "gl",
    "gr",
    "kl",
    "kr",
    "pl",
    "pr",
    "tr",
    "zw",
  ]),
};

const TABLES: Record<string, Record<string, string[]>> = { english, german };

/** `table[key]` only when it is the table's own: a word or language like "constructor" isn't one of Object's. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Python's `sorted(..., key=len, reverse=True)`: stable, so equal lengths keep their order. */
function byLength(groups: string[]): string[] {
  return groups.toSorted((a, b) => [...b].length - [...a].length);
}

/** Python's Unicode `[^\w']+`: anything but letters, numbers, `_` and `'`. */
const NOT_WORD = /[^\p{L}\p{N}_']+/gu;

/** A word as the learned tables key it: lowercase letters and apostrophes. */
export function normalize(word: string): string {
  return word.toLowerCase().replaceAll("’", "'").replace(NOT_WORD, "");
}

function startsWith(chars: string[], group: string, at: number): boolean {
  const parts = [...group];
  return parts.every((char, k) => chars[at + k] === char);
}

/** [start, end) of each vowel sound in the (lowercase) word, in code points. */
function nuclei(word: string[], language: string): [number, number][] {
  const vowels = own(VOWELS, language) ?? VOWELS.english!;
  const digraphs = own(DIGRAPHS, language) ?? DIGRAPHS.english!;
  const out: [number, number][] = [];
  let i = 0;
  while (i < word.length) {
    const char = word[i]!;
    if (vowels.includes(char) && !(char === "y" && i === 0)) {
      const digraph = digraphs.find((d) => startsWith(word, d, i));
      if (digraph) {
        out.push([i, i + [...digraph].length]);
        i += [...digraph].length;
      } else if (char === "u" && i > 0 && word[i - 1] === "q") {
        // "qu": the u belongs to the consonant.
        i += 1;
      } else {
        out.push([i, i + 1]);
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  if (language === "english" && out.length > 1) {
    // Silent final e ("make", "love"), but not "-le" ("little") or a word that is all vowels before it.
    const [s, e] = out.at(-1)!;
    const text = word.join("");
    const nucleus = word.slice(s, e).join("");
    const third = word.at(-3) ?? "";
    if (nucleus === "e" && e === word.length && !text.endsWith("le")) {
      out.pop();
    } else if (
      text.endsWith("es") &&
      nucleus === "e" &&
      e === word.length - 1 &&
      word.length > 3 &&
      !"scxz".includes(third)
    ) {
      out.pop(); // "makes", but keep "kisses"
    } else if (text.endsWith("ed") && nucleus === "e" && e === word.length - 1 && !"td".includes(third)) {
      out.pop(); // "loved", but keep "wanted"
    }
  }
  return out;
}

/** Split before the consonants leading into each vowel sound (one consonant or a known onset cluster). */
export function ruleSplit(word: string, language: string): string[] {
  const original = [...word];
  const low = [...word.toLowerCase()];
  const found = nuclei(low, language);
  if (found.length < 2) return [word];
  const onsets = own(ONSETS, language) ?? ONSETS.english!;
  const cuts: number[] = [];
  for (let k = 1; k < found.length; k++) {
    const previousEnd = found[k - 1]![1];
    const start = found[k]![0];
    const cluster = low.slice(previousEnd, start).join("");
    const onset = onsets.find((o) => cluster.endsWith(o));
    if (!cluster) cuts.push(start); // vowel directly after vowel: "cre-ate"
    else if (onset) cuts.push(start - [...onset].length);
    else cuts.push(start - 1); // one consonant starts the next syllable
  }
  const parts: string[] = [];
  let last = 0;
  for (const cut of cuts) {
    if (cut > last) {
      parts.push(original.slice(last, cut).join(""));
      last = cut;
    }
  }
  parts.push(original.slice(last).join(""));
  return parts.filter((part) => part);
}

/** A word's sung syllables, keeping its casing and punctuation; `language` is e.g. "english" (any case). */
export function syllabify(word: string, language: string): string[] {
  const lang = language.toLowerCase();
  const table = own(TABLES, lang);
  const pattern = table && own(table, normalize(word));
  if (!pattern) return ruleSplit(word, lang);
  // Map the learned split (on normalized letters) back onto the original word.
  const bounds = new Set(
    pattern.slice(0, -1).map((_, i) => pattern.slice(0, i + 1).reduce((n, part) => n + [...part].length, 0)),
  );
  const chars = [...word];
  const out: string[] = [];
  let position = 0;
  let letters = 0;
  chars.forEach((char, i) => {
    if (!normalize(char)) return;
    if (bounds.has(letters) && i > position) {
      out.push(chars.slice(position, i).join(""));
      position = i;
    }
    letters += 1;
  });
  out.push(chars.slice(position).join(""));
  return out;
}
