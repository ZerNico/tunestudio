/**
 * Lyrics as the aligner reads them: ctc-forced-aligner's `preprocess_text(..., romanize=True, split_size="word")`
 * (text_normalize, uroman, normalize_uroman) without Python. The normalization sets and the per-character
 * romanization come from `data/aligner-text.json`, generated from the PoC's packages by
 * `poc/scripts/export_text_tables.py`; tests compare the tokens with the PoC's for thousands of lines.
 *
 * Supported scripts: Latin, Hangul and Chinese characters (they romanize character by character in uroman).
 */
import data from "./data/aligner-text.json";

/** Python's whitespace (`str.isspace`, `\s`), which differs from JavaScript's (U+FEFF, U+001C to U+001F). */
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const SPACES = new RegExp(`[${SPACE}]+`, "gu");
const TRIM = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");

const { normalization, romanization } = data;
/** The exact characters of norm_config's sets (written out by the generator; see there for their oddities). */
const PUNCTUATION = new Set(normalization.punctuation);
const DELETE = new Set(normalization.delete);
const DIGITS = `[${[...normalization.digits].map((c) => `\\u{${c.codePointAt(0)!.toString(16)}}`).join("")}]+`;
const DIGIT_WORDS = new RegExp(
  `^${DIGITS}(?=[${SPACE}])|(?<=[${SPACE}])${DIGITS}(?=[${SPACE}])|(?<=[${SPACE}])${DIGITS}$`,
  "gu",
);
/** Brackets with a number in them ("(Sam 23:17)"). */
const NUMBERED_BRACKETS = /\([^)]*\p{Nd}[^)]*\)/gu;
/** norm_config's mappings, Python patterns made JavaScript ones (`\S` is Python's non-whitespace). */
const MAPPINGS = normalization.mappings.map(
  ([pattern, replacement]) =>
    [new RegExp(pattern!.replaceAll("\\S", `[^${SPACE}]`), "gu"), replacement!.replaceAll(/\\(\d)/g, "$$$1")] as const,
);

const BASE: Record<string, string> = romanization.base;
const LANGUAGES: Record<string, Record<string, string>> = romanization.languages;

/** Python's `str.split()`: words between runs of whitespace. */
export function splitWords(text: string): string[] {
  return text.split(SPACES).filter((word) => word);
}

/** ctc-forced-aligner's `text_normalize` with the default config (every language this port supports). */
export function normalizeText(text: string): string {
  let out = text.normalize("NFKC").toLowerCase();
  out = out.replace(NUMBERED_BRACKETS, " ");
  for (const [pattern, replacement] of MAPPINGS) out = out.replace(pattern, replacement);
  out = [...out].map((c) => (PUNCTUATION.has(c) ? " " : DELETE.has(c) ? "" : c)).join("");
  out = out.replace(DIGIT_WORDS, " ");
  return out.replace(SPACES, " ").replace(TRIM, "");
}

/** A normalized word's romanized letters (a-z and '), as uroman and normalize_uroman leave them. */
export function romanize(word: string, language: string): string {
  const own = LANGUAGES[language];
  let out = "";
  for (const char of word) out += own?.[char] ?? BASE[char] ?? "";
  return out;
}

/**
 * The aligner's tokens for a line of lyrics in `language` (ISO 639-3, e.g. "eng"): one per word of the line (split
 * like Python's `str.split()`), each its letters separated by spaces ("d o n ' t"), "" for a word without letters.
 * preprocess_text also puts a "<star>" token before each; the caller adds those.
 */
export function alignerTokens(text: string, language: string): string[] {
  return splitWords(text).map((word) => [...romanize(normalizeText(word.replace(TRIM, "")), language)].join(" "));
}
