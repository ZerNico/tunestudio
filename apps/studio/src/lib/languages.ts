/**
 * Song languages: the ones offered in the new-project steps, their names, and the ones charts can be made in. Shared
 * by the renderer and the main process (codes are ISO 639-1; projects store the English name).
 */

/** The languages most songs are sung in, offered when choosing one. */
export const LANGUAGES = [
  "en",
  "de",
  "es",
  "fr",
  "it",
  "pt",
  "nl",
  "sv",
  "no",
  "da",
  "fi",
  "pl",
  "cs",
  "hu",
  "ro",
  "el",
  "tr",
  "ru",
  "uk",
  "ar",
  "he",
  "hi",
  "id",
  "ja",
  "ko",
  "zh",
];

/** The languages charts can be made in so far. */
export const CHART_LANGUAGES = ["en", "de"];

const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

/** "German" for "de"; the code itself if it isn't one. */
export function languageName(code: string): string {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The primary language of a tag ("en" for "en-US"), lowercase, or null when there is none. */
export function languageCode(tag: string | null | undefined): string | null {
  const code = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return code && /^[a-z]{2,3}$/.test(code) ? code : null;
}
