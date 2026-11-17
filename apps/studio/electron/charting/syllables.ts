/**
 * Splitting lyric words into sung syllables the way UltraStar charters do: the split learned from hand-made charts
 * where the word is known (`data/syllables-<language>.json`, read on first use), each language's vowel-group rules
 * otherwise (`data/syllable-rules.json`), corrected by patterns learned from its table where it has one
 * (`data/syllable-patterns.json`), and one syllable per character in Chinese, Hangul and kana. A port of the
 * training pipeline's `syllables.py` / `lyrics.syllabify`; tests check it against its output word for word.
 *
 * Strings are handled as code points, like Python's: an emoji or other character outside the BMP counts once.
 */
import { lazy, readTable } from "./tables";

/** How one language's spelling marks its sung syllables (`syllables.Rules`). */
interface Rules {
  vowels: string;
  /** Letter groups that are one vowel sound, longest first. */
  digraphs: string[];
  /** Consonant groups that stay together and start the next syllable, longest first. */
  onsets: string[];
  /** "english": silent final e, es, ed; "french": silent final e and es. */
  finalE: "" | "english" | "french";
  /** A y before a vowel is a consonant, and so is the y ending a group like "ay" before a vowel. */
  yGlide: boolean;
  /** Japanese: an n that no vowel or y follows is a syllable of its own. */
  moraicN: boolean;
  /** Portuguese: a final "ia", "io", "ua" (...) is two syllables in a word without an accent mark. */
  finalHiatus: boolean;
  /** A language whose learned splits also apply (romanized K-pop and J-pop charts are full of English words). */
  loanwords: string;
}

const RULES = lazy(() => readTable("syllable-rules.json") as { languages: Record<string, Rules>; default: Rules });

type LearnedTable = Record<string, string[]>;

/** The learned splits by language, each read on first use. */
const TABLES: Record<string, () => LearnedTable> = {
  english: lazy(() => readTable("syllables-english.json") as LearnedTable),
  german: lazy(() => readTable("syllables-german.json") as LearnedTable),
  spanish: lazy(() => readTable("syllables-spanish.json") as LearnedTable),
  portuguese: lazy(() => readTable("syllables-portuguese.json") as LearnedTable),
  french: lazy(() => readTable("syllables-french.json") as LearnedTable),
  italian: lazy(() => readTable("syllables-italian.json") as LearnedTable),
};

/**
 * Liang hyphenation patterns that correct the rules (`syllables.learn_patterns`): letters ("." a word edge) and a
 * value per gap between them. A word's gap takes the highest value of every pattern around it; odd is a cut.
 */
type Patterns = Record<string, number[]>;

const PATTERNS = lazy(() => readTable("syllable-patterns.json") as Record<string, Patterns>);
const LONGEST = new Map<Patterns, number>();

/** Rising diphthongs a final hiatus splits, and the accented letters that rule it out. */
const RISING = new Set(["ia", "ie", "io", "ua", "ue", "uo"]);
const MARKED = new Set("áàâãéêíóôõú");

/** Writing systems whose characters are syllables (Chinese characters, Hangul) or morae (kana). */
const SYLLABIC = /[㐀-䶿一-鿿豈-﫿가-힣ぁ-ゖァ-ヺ]/u;
/** Small kana and the long-vowel mark belong to the mora before them. */
const SMALL_KANA = new Set("ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶー");

/** `table[key]` only when it is the table's own: a word or language like "constructor" isn't one of Object's. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** A language as the rules know it: lowercase, without a variant ("Portuguese (Brazil)" is "portuguese"). */
export function languageKey(language: string): string {
  return language
    .trim()
    .toLowerCase()
    .replace(/\s*\(.*\)$/u, "");
}

function rulesFor(language: string): Rules {
  const { languages, default: fallback } = RULES();
  return own(languages, languageKey(language)) ?? fallback;
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

/** One syllable per Chinese character, Hangul block or kana mora; anything else stays with its neighbour. */
function syllabicSplit(word: string): string[] | null {
  if (!SYLLABIC.test(word)) return null;
  const parts: string[] = [];
  let prefix = "";
  for (const char of word) {
    if (SYLLABIC.test(char) && !SMALL_KANA.has(char)) {
      parts.push(prefix + char);
      prefix = "";
    } else if (parts.length) {
      parts[parts.length - 1] += char;
    } else {
      prefix += char;
    }
  }
  if (prefix) parts.push(prefix);
  return parts;
}

/** [start, end) of each vowel sound in the (lowercase) word, in code points. */
export function nuclei(word: string[], language: string): [number, number][] {
  const rules = rulesFor(language);
  const vowelAt = (k: number) => k < word.length && rules.vowels.includes(word[k]!);
  const out: [number, number][] = [];
  let i = 0;
  while (i < word.length) {
    const char = word[i]!;
    if (rules.vowels.includes(char) && !(char === "y" && (i === 0 || (rules.yGlide && vowelAt(i + 1))))) {
      const digraph = rules.digraphs.find(
        (d) => startsWith(word, d, i) && !(rules.yGlide && d.endsWith("y") && vowelAt(i + [...d].length)),
      );
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
    } else if (
      rules.moraicN &&
      char === "n" &&
      out.length &&
      out.at(-1)![1] === i &&
      !vowelAt(i + 1) &&
      word[i + 1] !== "y"
    ) {
      out.push([i, i + 1]);
      i += 1;
    } else {
      i += 1;
    }
  }
  if (rules.finalE === "english" && out.length > 1) {
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
  if (rules.finalHiatus && out.length && !word.some((char) => MARKED.has(char))) {
    const [s, e] = out.at(-1)!;
    const rest = word.slice(e).join("");
    if (
      RISING.has(word.slice(s, e).join("")) &&
      ["", "s", "m"].includes(rest) &&
      !(s > 0 && "qg".includes(word[s - 1]!))
    ) {
      out.splice(-1, 1, [s, s + 1], [s + 1, e]);
    }
  }
  if (rules.finalE === "french" && out.length > 1) {
    // Charters leave a final e or es unsung ("danse", "elle", "aimes", "poupée").
    const [s, e] = out.at(-1)!;
    if (word.slice(s, e).join("") === "e" && ["", "s"].includes(word.slice(e).join(""))) out.pop();
  }
  return out;
}

/** Split before the consonants leading into each vowel sound (one consonant or a known onset cluster). */
export function ruleSplit(word: string, language: string): string[] {
  const syllabic = syllabicSplit(word);
  if (syllabic) return syllabic;
  const original = [...word];
  const low = [...word.toLowerCase()];
  const found = nuclei(low, language);
  if (found.length < 2) return [word];
  const { onsets } = rulesFor(language);
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

/** The rules' cuts of a normalized word as gap values of ".key.": a cut before letter i is gap i + 1. */
function ruleValues(key: string, language: string): number[] {
  const values = Array.from<number>({ length: [...key].length + 3 }).fill(0);
  let position = 0;
  for (const part of ruleSplit(key, language).slice(0, -1)) {
    position += [...part].length;
    values[position + 1] = 1;
  }
  return values;
}

/** A normalized word's split: the rules' cuts corrected by the patterns, then parts without a vowel joined on. */
function patternSplit(key: string, language: string, patterns: Patterns): string[] {
  const dotted = [".", ...key, "."];
  const values = ruleValues(key, language);
  let longest = LONGEST.get(patterns);
  if (longest === undefined) {
    longest = Math.max(0, ...Object.keys(patterns).map((k) => [...k].length));
    LONGEST.set(patterns, longest);
  }
  for (let a = 0; a < dotted.length; a++) {
    for (let b = a + 1; b <= Math.min(dotted.length, a + longest); b++) {
      const found = own(patterns, dotted.slice(a, b).join(""));
      found?.forEach((x, t) => {
        if (x > values[a + t]!) values[a + t] = x;
      });
    }
  }
  const letters = [...key];
  const parts: string[] = [];
  let last = 0;
  for (let gap = 2; gap <= letters.length; gap++) {
    if (values[gap]! % 2 === 1) {
      parts.push(letters.slice(last, gap - 1).join(""));
      last = gap - 1;
    }
  }
  parts.push(letters.slice(last).join(""));
  const vowels = new Set([...rulesFor(language).vowels, "y"]);
  const voiced = (part: string) => [...part].some((char) => vowels.has(char));
  const out: string[] = [];
  for (const part of parts) {
    if (out.length && (!voiced(part) || !voiced(out.at(-1)!))) out[out.length - 1] += part;
    else out.push(part);
  }
  return out;
}

/** The learned split of a word: its language's, else the language it borrows words from. */
function learned(word: string, language: string): string[] | undefined {
  const key = normalize(word);
  const ownSplit = own(TABLES, language)?.();
  const found = ownSplit && own(ownSplit, key);
  if (found) return found;
  const { loanwords } = rulesFor(language);
  const borrowed = loanwords ? own(TABLES, loanwords)?.() : undefined;
  return borrowed && own(borrowed, key);
}

/** A word's sung syllables, keeping its casing and punctuation; `language` is e.g. "English" or "Portuguese (Brazil)". */
export function syllabify(word: string, language: string): string[] {
  const lang = languageKey(language);
  let pattern = learned(word, lang);
  const key = normalize(word);
  const patterns = own(PATTERNS(), lang);
  if (!pattern && patterns && Object.keys(patterns).length && key && !syllabicSplit(key)) {
    pattern = patternSplit(key, lang, patterns);
  }
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
