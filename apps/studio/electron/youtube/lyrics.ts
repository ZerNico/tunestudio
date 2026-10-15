import { Effect, Schedule, Schema } from "effect";

import type { FoundLyrics, LyricsLine } from "../../src/lib/native/types";
import { LyricsUnavailable } from "../errors";
import { Downloads } from "../tools/downloads";
import { isVariant, normalize, similarity } from "./covers";

/*
 * Lyrics from LRCLIB (lrclib.net), an open database of line-synced lyrics. It often has several
 * versions of a song. Prefer the requested version, with studio lyrics as a fallback; within
 * each version, synced lyrics beat plain ones, then the closest length wins.
 */

const LrclibSearch = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    trackName: Schema.String,
    artistName: Schema.String,
    albumName: Schema.optional(Schema.NullOr(Schema.String)),
    duration: Schema.optional(Schema.NullOr(Schema.Number)),
    instrumental: Schema.optional(Schema.Boolean),
    plainLyrics: Schema.optional(Schema.NullOr(Schema.String)),
    syncedLyrics: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
type LrclibEntry = (typeof LrclibSearch.Type)[number];

const TIMESTAMP = /\[(\d+):(\d+(?:\.\d+)?)\]/g;

/**
 * Lines of an LRC text: `[mm:ss.xx] text`, sorted by time. A line with several timestamps (a
 * repeated chorus written once) appears once per timestamp; empty lines are breaks and dropped.
 */
export function parseLrc(text: string): LyricsLine[] {
  const lines: LyricsLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const starts = [...raw.matchAll(TIMESTAMP)].map((match) => Number(match[1]) * 60 + Number(match[2]));
    const lyric = raw.replace(TIMESTAMP, "").trim();
    if (!lyric) continue;
    for (const start of starts) lines.push({ start, text: lyric });
  }
  return lines.toSorted((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

/** Lines of plain lyrics, without empty ones. */
export function plainLines(text: string): LyricsLine[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ start: null, text: line }));
}

/** The title without recording labels, for a second search when a live take has no lyrics. */
function studioTitle(title: string): string {
  return title
    .replace(/[([{].*?[)\]}]/g, " ")
    .replace(
      /\s+\p{Dash_Punctuation}\s+(?:live|acoustic|unplugged|remix|remastered|instrumental|karaoke|sped up|slowed)\b.*$/iu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Prefer the requested version, then studio lyrics for the same song. Within each, the exact
 * title beats one that only contains it, then synced lyrics and the closest length win.
 */
export function pickLyrics(
  entries: readonly LrclibEntry[],
  song: { artist: string; title: string; duration: number | null },
): LrclibEntry | undefined {
  const lengthOff = (entry: LrclibEntry) =>
    entry.duration && song.duration ? Math.abs(entry.duration - song.duration) : 30;
  const base = studioTitle(song.title);
  const sameVersion = (entry: LrclibEntry) => !isVariant(entry.trackName, song.title);
  const studioFallback = (entry: LrclibEntry) =>
    isVariant(song.title, base) &&
    normalize(entry.trackName) === normalize(base) &&
    !isVariant(entry.trackName, base) &&
    Boolean(entry.syncedLyrics?.trim() || entry.plainLyrics?.trim());
  const exact = (entry: LrclibEntry) => Number(normalize(entry.trackName) === normalize(song.title));
  return entries
    .filter(
      (entry) =>
        similarity(entry.artistName, song.artist) >= 0.6 &&
        similarity(entry.trackName, song.title) >= 0.9 &&
        (sameVersion(entry) || studioFallback(entry)) &&
        (entry.instrumental || entry.syncedLyrics || entry.plainLyrics),
    )
    .toSorted(
      (a, b) =>
        Number(sameVersion(b)) - Number(sameVersion(a)) ||
        exact(b) - exact(a) ||
        Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics)) ||
        lengthOff(a) - lengthOff(b),
    )[0];
}

/**
 * Lyrics for a song from LRCLIB, or null when it has none. Fails with `LyricsUnavailable` when
 * LRCLIB can't be reached (it is sometimes down for a while), after trying once more.
 */
export function findLyrics(song: { artist: string; title: string; duration: number | null }) {
  return Effect.gen(function* () {
    if (!song.artist.trim() || !song.title.trim()) return null;
    const downloads = yield* Downloads;
    const search = (title: string) => {
      const query = `track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(song.artist)}`;
      return downloads.json(`https://lrclib.net/api/search?${query}`).pipe(
        Effect.timeout("10 seconds"),
        Effect.retry({ times: 1, schedule: Schedule.spaced("1500 millis") }),
        Effect.flatMap(Schema.decodeUnknownEffect(LrclibSearch)),
        Effect.mapError(
          () => new LyricsUnavailable({ message: "LRCLIB can't be reached right now. Try again in a moment." }),
        ),
      );
    };
    const entries = yield* search(song.title);
    let entry = pickLyrics(entries, song);
    const base = studioTitle(song.title);
    if ((!entry || isVariant(entry.trackName, song.title)) && base && isVariant(song.title, base)) {
      // A search containing "Live" may never return the studio recording. Keep a usable result
      // if this second lookup fails, rather than losing lyrics we already found.
      const alternatives = yield* search(base).pipe(
        Effect.catch((error) => (entry ? Effect.succeed([]) : Effect.fail(error))),
      );
      entry = pickLyrics([...entries, ...alternatives], song);
    }
    if (!entry) return null;
    const lines = entry.syncedLyrics ? parseLrc(entry.syncedLyrics) : plainLines(entry.plainLyrics ?? "");
    return {
      source: "lrclib",
      id: entry.id,
      artist: entry.artistName,
      title: entry.trackName,
      album: entry.albumName ?? null,
      duration: entry.duration ?? null,
      synced: Boolean(entry.syncedLyrics) && lines.length > 0,
      instrumental: entry.instrumental ?? false,
      versionMismatch: isVariant(entry.trackName, song.title),
      lines,
    } satisfies FoundLyrics;
  });
}
