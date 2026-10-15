/**
 * A guess at the language of lyrics from their most common little words, for lyrics that don't say (LRCLIB's, the
 * user's own). Only the languages charts can be made in are told apart; anything else is "don't know".
 */

/** Words that are common in one language's lyrics and rare in the other's. */
const COMMON_WORDS: Record<string, readonly string[]> = {
  en: [
    "the",
    "and",
    "you",
    "i",
    "me",
    "my",
    "it's",
    "is",
    "to",
    "your",
    "of",
    "that",
    "don't",
    "i'm",
    "love",
    "we",
    "be",
    "all",
  ],
  de: [
    "ich",
    "und",
    "du",
    "die",
    "der",
    "das",
    "nicht",
    "ist",
    "ein",
    "eine",
    "mir",
    "mich",
    "dich",
    "wir",
    "es",
    "zu",
    "auf",
    "nur",
  ],
};

/** ISO 639-1 code of the language most of the words come from ("en", "de"), or null when it isn't clear. */
export function guessLyricsLanguage(text: string): string | null {
  const words =
    text
      .toLowerCase()
      .replaceAll("’", "'")
      .match(/[\p{L}']+/gu) ?? [];
  const counts = Object.fromEntries(
    Object.entries(COMMON_WORDS).map(([code, common]) => [code, words.filter((word) => common.includes(word)).length]),
  );
  const [best, second] = Object.entries(counts).toSorted((a, b) => b[1] - a[1]);
  if (!best || best[1] < 3) return null;
  // Clearly more of one language's words than the other's.
  return best[1] >= 2 * (second?.[1] ?? 0) ? best[0] : null;
}
