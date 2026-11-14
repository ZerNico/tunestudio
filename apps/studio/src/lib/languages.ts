/**
 * Song languages: the ones offered in the new-project steps, their names, and the ones whose charts have been checked
 * against hand-made ones. Shared by the renderer and the main process (codes are ISO 639-1; projects store the English
 * name).
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

/** Languages whose made charts have been compared with hand-made ones; the others chart with less tested rules. */
export const CHECKED_CHART_LANGUAGES = ["en", "de"];

/** Made on first use: loading ICU's names slows starting main and the page. */
let languageNames: Intl.DisplayNames | undefined;

/** "German" for "de"; the code itself if it isn't one. */
export function languageName(code: string): string {
  try {
    languageNames ??= new Intl.DisplayNames(["en"], { type: "language" });
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The code of a language as projects store it ("English", "Portuguese (Brazil)", or a code like "de"), or null when it
 * isn't one.
 */
export function codeOfLanguage(name: string | null | undefined): string | null {
  const wanted = name
    ?.trim()
    .toLowerCase()
    .replace(/\s*\(.*\)$/u, "");
  if (!wanted) return null;
  return LANGUAGES.find((code) => languageName(code).toLowerCase() === wanted) ?? languageCode(wanted);
}

/** The primary language of a tag ("en" for "en-US"), lowercase, or null when there is none. */
export function languageCode(tag: string | null | undefined): string | null {
  const code = tag?.trim().toLowerCase().split(/[-_]/)[0];
  return code && /^[a-z]{2,3}$/.test(code) ? code : null;
}
