import { Effect, FileSystem, Schedule, Schema, Semaphore } from "effect";

import type { CoverCandidate } from "../../src/lib/native/types";
import { Desktop } from "../services/desktop";
import { Downloads } from "../tools/downloads";

/*
 * Covers for a song from iTunes (in the user's store), Deezer and MusicBrainz with the Cover Art
 * Archive, scored by how well artist, title and length match the video. The song's own single
 * comes before an album. A source that fails or is slow just adds nothing.
 */

/** How many catalog covers the dialog offers, besides the video's thumbnail. */
const MAX_COVERS = 5;

/** Lowercase letters and digits only, without accents and bracketed parts like "(Remastered)". */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[([{].*?[)\]}]/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** How alike two names are, from 0 to 1: 1 when equal, 0.9 when one contains the other, else shared words. */
export function similarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.9;
  const words = new Set(left.split(" "));
  const other = right.split(" ");
  const shared = other.filter((word) => words.has(word)).length;
  return shared / Math.max(words.size, other.length);
}

/** Words that make a release another version of a song, also outside brackets ("Song - Live"). */
const VARIANT =
  /\b(re-?mix(es)?|mix(es)?|live|edit|version|instrumental|acoustic|karaoke|remaster(ed)?|sped up|slowed)\b/i;

/** Album names that hold other versions of their songs; "(Deluxe)" or "(Bonus Track Version)" don't. */
const VARIANT_ALBUM = /\b(live|karaoke|re-?mix(es)?|mix(es)?|instrumental|acoustic|unplugged)\b/i;

/** Bracketed additions that don't make another version: a featured artist, the radio or single edit. */
const SAME_VERSION = /^(feat\.?|ft\.?|featuring|with)\s|^(radio|single) (edit|version)$|^original( mix| version)?$/i;

/** The same-version phrases outside brackets too: "Song - Radio Edit". */
const SAME_VERSION_WORDS = /\b(radio|single) (edit|version)\b|\boriginal (mix|version)\b/gi;

/** Whether `name` says it is a version that `other` doesn't: a remix, a live take, a bracketed addition. */
function addsVersion(name: string, other: string): boolean {
  const song = other.toLowerCase();
  const word = VARIANT.exec(name.replace(/[([][^)\]]*[)\]]/g, " ").replace(SAME_VERSION_WORDS, " "));
  if (word && !song.includes(word[0].toLowerCase())) return true;
  const additions = [...name.matchAll(/[([]([^)\]]+)[)\]]/g)].map((match) => match[1]!.trim());
  return additions.some((addition) => !SAME_VERSION.test(addition) && !song.includes(addition.toLowerCase()));
}

/**
 * Whether `name` is another version than the song called `title`: a remix, a live take, or any
 * bracketed addition one has and the other doesn't ("(Pianoforte)", "(Club Mix)"). Both ways: the
 * studio recording isn't "Song (Live)" either.
 */
export function isVariant(name: string, title: string): boolean {
  return addsVersion(name, title) || addsVersion(title, name);
}

/** Whether the album `name` holds another version of the song called `title` (a live album, remixes). */
export function isVariantAlbum(name: string, title: string): boolean {
  const word = VARIANT_ALBUM.exec(name);
  return word !== null && !title.toLowerCase().includes(word[0].toLowerCase());
}

/** Album names that are compilations or soundtracks: the song's own album is the better cover. */
const COMPILATION =
  /\b(best of|greatest hits|the hits|hits collection|collection|essentials?|anthology|originals|compilation|soundtrack|sampler|karaoke)\b/i;

/** What a catalog says about one recording or release. */
export interface CatalogMatch {
  artist: string;
  title: string;
  album: string | null;
  /** A single or EP (the song's own cover), or an album. */
  release: CoverCandidate["release"];
  year: number | null;
  genre: string | null;
  /** Seconds. */
  duration: number | null;
  url: string;
  preview: string;
  source: CoverCandidate["source"];
}

/**
 * How well a catalog entry fits the song, and whether it is the same recording (so its year and
 * genre can be used). Videos often run a few seconds longer than the track, so length only has
 * to be close. A single named like the song is its own cover and ranks first; another track of
 * an album named like the song (a title track not listed itself) still has the right cover.
 */
export function scoreMatch(
  match: Pick<CatalogMatch, "artist" | "title" | "album" | "release" | "duration">,
  song: { artist: string; title: string; duration: number | null },
): { score: number; artist: number; title: number; confident: boolean } {
  const artist = similarity(match.artist, song.artist);
  const track = similarity(match.title, song.title);
  const release = match.album ? similarity(match.album, song.title) : 0;
  const title = Math.max(track, release * 0.85);
  const difference =
    match.duration !== null && song.duration !== null ? Math.abs(match.duration - song.duration) : null;
  const length = difference === null ? 0.5 : difference <= 5 ? 1 : difference <= 20 ? 0.7 : 0.2;
  const variant =
    isVariant(match.title, song.title) ||
    (match.album !== null &&
      (match.release === "single" ? isVariant(match.album, song.title) : isVariantAlbum(match.album, song.title)));
  const lengthFits = difference === null || difference <= 20;
  const ownSingle = match.release === "single" && release >= 0.9 && !variant && lengthFits;
  const sameLength = difference === null ? ownSingle : difference <= 20;
  const compilation = match.release === "album" && match.album !== null && COMPILATION.test(match.album);
  return {
    score:
      artist * 0.4 + title * 0.4 + length * 0.2 + (ownSingle ? 0.2 : 0) - (variant ? 0.3 : 0) - (compilation ? 0.1 : 0),
    artist,
    title,
    confident: artist >= 0.9 && track >= 0.9 && sameLength && !variant,
  };
}

const yearOf = (date: string | undefined | null) => {
  const year = Number.parseInt(date?.slice(0, 4) ?? "", 10);
  return Number.isFinite(year) ? year : null;
};

const ItunesSearch = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      artistName: Schema.String,
      trackName: Schema.optional(Schema.String),
      collectionName: Schema.optional(Schema.String),
      releaseDate: Schema.optional(Schema.String),
      primaryGenreName: Schema.optional(Schema.String),
      trackTimeMillis: Schema.optional(Schema.Number),
      artworkUrl100: Schema.optional(Schema.String),
    }),
  ),
});

/** iTunes artwork comes in any size: the URL names it. */
const itunesArtwork = (url: string, size: number) => url.replace(/\/\d+x\d+bb\.(jpg|png)$/, `/${size}x${size}bb.jpg`);

/** Songs in the iTunes store of the user's country (stores differ a lot), with their release's artwork. */
function searchItunes(song: { artist: string; title: string }) {
  return Effect.gen(function* () {
    const downloads = yield* Downloads;
    const { country } = yield* Desktop;
    const term = encodeURIComponent(`${song.artist} ${song.title}`);
    const json = yield* downloads.json(
      `https://itunes.apple.com/search?term=${term}&entity=song&media=music&limit=25&country=${country}`,
    );
    const { results } = yield* Schema.decodeUnknownEffect(ItunesSearch)(json);
    return results.flatMap((result): CatalogMatch[] => {
      if (!result.trackName || !result.artworkUrl100) return [];
      const collection = result.collectionName ?? null;
      const single = collection !== null && / - (Single|EP)$/.test(collection);
      return [
        {
          artist: result.artistName,
          title: result.trackName,
          album: collection?.replace(/ - (Single|EP)$/, "") ?? null,
          release: single ? "single" : "album",
          year: yearOf(result.releaseDate),
          genre: result.primaryGenreName ?? null,
          duration: result.trackTimeMillis ? result.trackTimeMillis / 1000 : null,
          url: itunesArtwork(result.artworkUrl100, 1200),
          preview: itunesArtwork(result.artworkUrl100, 300),
          source: "itunes",
        },
      ];
    });
  });
}

const DeezerTracks = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      duration: Schema.optional(Schema.Number),
      artist: Schema.Struct({ name: Schema.String }),
      album: Schema.Struct({ title: Schema.String, cover_medium: Schema.String, cover_xl: Schema.String }),
    }),
  ),
});

const DeezerAlbums = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      record_type: Schema.optional(Schema.String),
      artist: Schema.Struct({ name: Schema.String }),
      cover_medium: Schema.String,
      cover_xl: Schema.String,
    }),
  ),
});

/** Songs on Deezer, and its singles and EPs named like the song (its song search doesn't say which release is a single). */
function searchDeezer(song: { artist: string; title: string }) {
  return Effect.gen(function* () {
    const downloads = yield* Downloads;
    const query = encodeURIComponent(`${song.artist} ${song.title}`);
    const [tracks, albums] = yield* Effect.all(
      [
        downloads
          .json(`https://api.deezer.com/search?q=${query}&limit=25`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(DeezerTracks))),
        downloads
          .json(`https://api.deezer.com/search/album?q=${query}&limit=10`)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(DeezerAlbums))),
      ],
      { concurrency: "unbounded" },
    );
    const singles = albums.data.flatMap((album): CatalogMatch[] =>
      album.record_type === "single" || album.record_type === "ep"
        ? [
            {
              artist: album.artist.name,
              title: album.title,
              album: album.title,
              release: "single",
              year: null,
              genre: null,
              duration: null,
              url: album.cover_xl,
              preview: album.cover_medium,
              source: "deezer",
            },
          ]
        : [],
    );
    const songs = tracks.data.map((track): CatalogMatch => ({
      artist: track.artist.name,
      title: track.title,
      album: track.album.title,
      release: "album",
      year: null,
      genre: null,
      duration: track.duration ?? null,
      url: track.album.cover_xl,
      preview: track.album.cover_medium,
      source: "deezer",
    }));
    return [...singles, ...songs];
  });
}

const ReleaseGroup = Schema.Struct({
  id: Schema.String,
  "primary-type": Schema.optional(Schema.NullOr(Schema.String)),
});

const MusicBrainzRecordings = Schema.Struct({
  recordings: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      length: Schema.optional(Schema.NullOr(Schema.Number)),
      "first-release-date": Schema.optional(Schema.String),
      "artist-credit": Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
      releases: Schema.optional(
        Schema.Array(
          Schema.Struct({
            title: Schema.String,
            status: Schema.optional(Schema.String),
            "release-group": Schema.optional(ReleaseGroup),
          }),
        ),
      ),
    }),
  ),
});

const MusicBrainzReleaseGroups = Schema.Struct({
  "release-groups": Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      "primary-type": Schema.optional(Schema.NullOr(Schema.String)),
      "first-release-date": Schema.optional(Schema.NullOr(Schema.String)),
      "artist-credit": Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
    }),
  ),
});

/** MusicBrainz allows one request a second per computer: every request waits its turn. */
const musicBrainzTurn = Effect.runSync(Semaphore.make(1));
let musicBrainzLast = 0;

/** A MusicBrainz request, at least 1.1 s after the one before, tried once more if it is turned away. */
function musicBrainzJson(url: string) {
  const request = Effect.gen(function* () {
    const wait = musicBrainzLast + 1100 - Date.now();
    if (wait > 0) yield* Effect.sleep(`${wait} millis`);
    musicBrainzLast = Date.now();
    return yield* Downloads.use((downloads) => downloads.json(url));
  });
  return musicBrainzTurn.withPermits(1)(
    request.pipe(Effect.retry({ times: 1, schedule: Schedule.spaced("1500 millis") })),
  );
}

/** Quotes a phrase for MusicBrainz's Lucene search. */
const phrase = (text: string) => `"${text.replace(/["\\]/g, " ")}"`;

/** The Cover Art Archive's front cover of a release group, full size and as a preview. */
const coverArt = (group: string) => `https://coverartarchive.org/release-group/${group}/front-1200`;
const coverArtPreview = (group: string) => `https://coverartarchive.org/release-group/${group}/front-250`;

const credits = (credit: readonly { name: string }[] | undefined) =>
  credit?.map((entry) => entry.name).join(", ") ?? "";

/**
 * Singles and EPs named like the song on MusicBrainz, then its recordings with an album they are
 * on (a recording's search result names its albums, not its single).
 */
function searchMusicBrainz(song: { artist: string; title: string }) {
  return Effect.gen(function* () {
    const singlesQuery = encodeURIComponent(
      `releasegroup:${phrase(song.title)} AND artist:${phrase(song.artist)} AND (primarytype:single OR primarytype:ep)`,
    );
    const groups = yield* musicBrainzJson(
      `https://musicbrainz.org/ws/2/release-group?query=${singlesQuery}&fmt=json&limit=5`,
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(MusicBrainzReleaseGroups)));
    const singles = groups["release-groups"].map((group): CatalogMatch => ({
      artist: credits(group["artist-credit"]),
      title: group.title,
      album: group.title,
      release: "single",
      year: yearOf(group["first-release-date"]),
      genre: null,
      duration: null,
      url: coverArt(group.id),
      preview: coverArtPreview(group.id),
      source: "musicbrainz",
    }));

    const recordingsQuery = encodeURIComponent(`recording:${phrase(song.title)} AND artist:${phrase(song.artist)}`);
    const { recordings } = yield* musicBrainzJson(
      `https://musicbrainz.org/ws/2/recording?query=${recordingsQuery}&fmt=json&limit=10`,
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(MusicBrainzRecordings)));
    const albums = recordings.flatMap((recording): CatalogMatch[] => {
      const releases = (recording.releases ?? []).filter((release) => release["release-group"]);
      const release =
        releases.find(
          (candidate) => candidate.status === "Official" && candidate["release-group"]?.["primary-type"] === "Album",
        ) ?? releases[0];
      const group = release?.["release-group"];
      if (!release || !group) return [];
      return [
        {
          artist: credits(recording["artist-credit"]),
          title: recording.title,
          album: release.title,
          release: group["primary-type"] === "Single" || group["primary-type"] === "EP" ? "single" : "album",
          year: yearOf(recording["first-release-date"]),
          genre: null,
          duration: recording.length ? recording.length / 1000 : null,
          url: coverArt(group.id),
          preview: coverArtPreview(group.id),
          source: "musicbrainz",
        },
      ];
    });
    return [...singles, ...albums];
  });
}

/** A catalog search, or nothing when it fails or takes too long. */
const quietly = <A, E, R>(search: Effect.Effect<A[], E, R>) =>
  search.pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed((): A[] => []),
  );

/** A small JPEG data URL of an image on the internet, or null when it can't be had. */
export function previewImage(url: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const downloads = yield* Downloads;
    const desktop = yield* Desktop;
    const file = yield* fs.makeTempFileScoped({ prefix: "tunestudio-preview-" });
    yield* downloads.file(url, file, () => Effect.void);
    return yield* desktop.thumbnail(yield* fs.readFile(file));
  }).pipe(
    Effect.scoped,
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => null),
  );
}

/**
 * Which release a cover belongs to, so the same one found in several catalogs is offered once.
 * Bracketed parts count here: "Song (Remix)" is another release than "Song".
 */
const releaseKey = (match: CatalogMatch) =>
  `${match.release} ${(match.album ?? match.title)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()}`;

/**
 * Covers for a song, best match first: each release once, and only with a preview that could be
 * fetched. A release found in several catalogs uses the best-scored one whose preview loads (the
 * Cover Art Archive has no art for some releases).
 */
export function findCovers(song: { artist: string; title: string; duration: number | null }) {
  return Effect.gen(function* () {
    if (!song.artist.trim() || !song.title.trim()) return [];
    const found = yield* Effect.all(
      [quietly(searchItunes(song)), quietly(searchDeezer(song)), quietly(searchMusicBrainz(song))],
      {
        concurrency: "unbounded",
      },
    );

    const ranked = found
      .flat()
      .map((match) => Object.assign(scoreMatch(match, song), { match }))
      // Another artist's version, or another song by the artist, isn't this song's cover.
      .filter((entry) => entry.artist >= 0.6 && entry.title >= 0.6 && entry.score >= 0.5)
      // The earlier release first among equals: usually the original rather than a re-release.
      .toSorted((a, b) => b.score - a.score || (a.match.year ?? 9999) - (b.match.year ?? 9999));

    // Each release with its catalog entries, best first (a Map keeps the order releases came in).
    const releases = new Map<string, typeof ranked>();
    const urls = new Set<string>();
    for (const entry of ranked) {
      if (urls.has(entry.match.url)) continue;
      urls.add(entry.match.url);
      const key = releaseKey(entry.match);
      releases.set(key, [...(releases.get(key) ?? []), entry]);
    }

    const withPreviews = yield* Effect.forEach(
      [...releases.values()].slice(0, MAX_COVERS + 2),
      (entries) =>
        Effect.gen(function* () {
          for (const entry of entries) {
            const preview = yield* previewImage(entry.match.preview);
            if (!preview) continue;
            return {
              url: entry.match.url,
              preview,
              source: entry.match.source,
              release: entry.match.release,
              artist: entry.match.artist,
              title: entry.match.title,
              album: entry.match.album,
              year: entry.match.year,
              genre: entry.match.genre,
              confident: entry.confident,
            } satisfies CoverCandidate;
          }
          return null;
        }),
      { concurrency: 4 },
    );
    return withPreviews.filter((cover): cover is CoverCandidate => cover !== null).slice(0, MAX_COVERS);
  });
}
