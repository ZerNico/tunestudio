import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { recordingDesktop, tempDir } from "../testing";
import { DownloadFailed, Downloads, hostAllowed } from "../tools/downloads";
import { findCovers, isVariant, normalize, scoreMatch, similarity } from "./covers";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

const ITUNES = "https://itunes.apple.com/search?";
const DEEZER_TRACKS = "https://api.deezer.com/search?";
const DEEZER_ALBUMS = "https://api.deezer.com/search/album?";
const MB_RECORDINGS = "https://musicbrainz.org/ws/2/recording?";
const MB_GROUPS = "https://musicbrainz.org/ws/2/release-group?";

const track = (artist: string, title: string, album: string, seconds: number, art: string) => ({
  artistName: artist,
  trackName: title,
  collectionName: album,
  releaseDate: "2023-03-17T12:00:00Z",
  primaryGenreName: "Pop",
  trackTimeMillis: seconds * 1000,
  artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/${art}/100x100bb.jpg`,
});

/** Catalog answers by URL prefix; images by URL (missing ones fail like a 404). */
function fakeCatalogs(answers: Record<string, unknown> & { images?: string[] }) {
  const requests: string[] = [];
  const fail = (url: string) => Effect.fail(new DownloadFailed({ url, message: "The server answered 404." }));
  const layer = Layer.succeed(Downloads, {
    json: (url) =>
      Effect.suspend(() => {
        requests.push(url);
        // The longest matching prefix: the album search's URL starts like the song search's.
        const prefix = Object.keys(answers)
          .filter((key) => url.startsWith(key))
          .toSorted((a, b) => b.length - a.length)[0];
        return prefix ? Effect.succeed(answers[prefix]) : fail(url);
      }),
    text: fail,
    redirect: fail,
    file: (url, file) =>
      Effect.suspend(() => {
        requests.push(url);
        if (!(answers.images ?? []).includes(url)) return fail(url);
        fs.writeFileSync(file, `image ${url}`);
        return Effect.succeed({ sha256: "", size: 1 });
      }),
  });
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const desktop = recordingDesktop(path.join(dir, "Music"));
  return {
    requests,
    layer: Layer.mergeAll(layer, desktop.layer).pipe(Layer.provideMerge(NodeServices.layer)),
  };
}

const SONG = { artist: "RAUM27", title: "Plattenbaum", duration: 210 };

describe("matching", () => {
  it("compares names without case, accents, punctuation or bracketed extras", () => {
    expect(normalize("Beyoncé – Halo (Remastered 2009)")).toBe("beyonce halo");
    expect(similarity("Simon & Garfunkel", "Simon and Garfunkel")).toBe(1);
    expect(similarity("Plattenbaum", "Plattenbaum (Live)")).toBe(1);
    expect(similarity("Frida", "Plattenbaum")).toBe(0);
  });

  it("trusts a match for year and genre only when it is the same song at about the same length", () => {
    expect(
      scoreMatch({ artist: "RAUM27", title: "Plattenbaum", album: null, release: "album", duration: 206 }, SONG),
    ).toMatchObject({ confident: true });
    // Same song, but a 4-minute version is another recording.
    expect(
      scoreMatch({ artist: "RAUM27", title: "Plattenbaum", album: null, release: "album", duration: 240 }, SONG)
        .confident,
    ).toBe(false);
    // Another track of an album named like the song: the right cover, but not this song's details.
    const titleTrack = scoreMatch(
      { artist: "RAUM27", title: "Frida", album: "Plattenbaum", release: "album", duration: 199 },
      SONG,
    );
    expect(titleTrack.confident).toBe(false);
    expect(titleTrack.score).toBeGreaterThan(0.5);
  });

  it("tells another version of the song apart", () => {
    expect(isVariant("Schüsse in die Luft (Donkong Remix)", "Schüsse in die Luft")).toBe(true);
    expect(isVariant("Blaues Licht (Live)", "Blaues Licht")).toBe(true);
    expect(isVariant("Blaues Licht (Live)", "Blaues Licht (Live)")).toBe(false);
    expect(isVariant("Blaues Licht", "Blaues Licht")).toBe(false);
    expect(isVariant("Never Gonna Give You Up (Pianoforte)", "Never Gonna Give You Up")).toBe(true);
    expect(isVariant("Blaues Licht (feat. Someone)", "Blaues Licht")).toBe(false);
    expect(isVariant("Blaues Licht (Radio Edit)", "Blaues Licht")).toBe(false);
    expect(isVariant("Blaues Licht - Radio Edit", "Blaues Licht")).toBe(false);
    // Both ways: asked for the live version, the studio recording is another version too.
    expect(isVariant("Blaues Licht", "Blaues Licht (Live)")).toBe(true);
    expect(isVariant("Blaues Licht", "Blaues Licht - Acoustic")).toBe(true);
    expect(isVariant("Blaues Licht", "Blaues Licht (feat. Someone)")).toBe(false);
    // A single of the song outranks the album it is on.
    const single = scoreMatch(
      { artist: "RAUM27", title: "Plattenbaum", album: "Plattenbaum", release: "single", duration: null },
      SONG,
    );
    const album = scoreMatch(
      { artist: "RAUM27", title: "Plattenbaum", album: "Anfangen Anzufangen", release: "album", duration: 206 },
      SONG,
    );
    expect(single.score).toBeGreaterThan(album.score);
    expect(single.confident).toBe(true);
  });

  it("allows subdomains only for hosts starting with a dot", () => {
    const hosts = ["archive.org", ".archive.org", "itunes.apple.com"];
    expect(hostAllowed("ia800503.us.archive.org", hosts)).toBe(true);
    expect(hostAllowed("archive.org", hosts)).toBe(true);
    expect(hostAllowed("evilarchive.org", hosts)).toBe(false);
    expect(hostAllowed("x.itunes.apple.com", hosts)).toBe(false);
  });
});

describe("findCovers", () => {
  it.live("puts the song's own single first, offers each release once, and skips other artists and missing art", () => {
    const { layer, requests } = fakeCatalogs({
      [ITUNES]: {
        results: [
          track("RAUM27", "Frida", "Anfangen Anzufangen", 199, "album-a"),
          track("RAUM27", "Plattenbaum", "Anfangen Anzufangen", 206, "album-a"),
          track("Someone Else", "Plattenbaum", "Covers", 210, "album-b"),
          // Another song by the artist, as long as the video: not this song's cover.
          track("RAUM27", "Sommergewitter", "Sommergewitter - Single", 210, "album-c"),
        ],
      },
      [DEEZER_TRACKS]: {
        data: [
          {
            title: "Plattenbaum",
            duration: 206,
            artist: { name: "RAUM27" },
            // The same album as on iTunes: offered once.
            album: {
              title: "Anfangen Anzufangen",
              cover_medium: "https://e-cdns-images.dzcdn.net/a/250.jpg",
              cover_xl: "https://e-cdns-images.dzcdn.net/a/1000.jpg",
            },
          },
        ],
      },
      [DEEZER_ALBUMS]: {
        data: [
          {
            title: "Plattenbaum (Club Remix)",
            record_type: "single",
            artist: { name: "RAUM27" },
            cover_medium: "https://e-cdns-images.dzcdn.net/remix/250.jpg",
            cover_xl: "https://e-cdns-images.dzcdn.net/remix/1000.jpg",
          },
        ],
      },
      [MB_GROUPS]: {
        "release-groups": [
          {
            id: "rg-single",
            title: "Plattenbaum",
            "primary-type": "Single",
            "first-release-date": "2023-02-10",
            "artist-credit": [{ name: "RAUM27" }],
          },
        ],
      },
      [MB_RECORDINGS]: {
        recordings: [
          {
            title: "Plattenbaum",
            length: 206_000,
            "artist-credit": [{ name: "RAUM27" }],
            releases: [{ title: "Bootleg", "release-group": { id: "rg-no-art", "primary-type": "Album" } }],
          },
        ],
      },
      images: [
        "https://is1-ssl.mzstatic.com/image/thumb/album-a/300x300bb.jpg",
        "https://is1-ssl.mzstatic.com/image/thumb/album-c/300x300bb.jpg",
        "https://e-cdns-images.dzcdn.net/a/250.jpg",
        "https://e-cdns-images.dzcdn.net/remix/250.jpg",
        "https://coverartarchive.org/release-group/rg-single/front-250",
      ],
    });
    return Effect.gen(function* () {
      const covers = yield* findCovers(SONG);
      expect(covers.map((cover) => [cover.source, cover.release, cover.album, cover.confident])).toEqual([
        ["musicbrainz", "single", "Plattenbaum", true],
        ["itunes", "album", "Anfangen Anzufangen", true],
        // A remix is offered, last, but its details aren't used.
        ["deezer", "single", "Plattenbaum (Club Remix)", false],
      ]);
      expect(covers[0]).toMatchObject({
        year: 2023,
        url: "https://coverartarchive.org/release-group/rg-single/front-1200",
      });
      expect(covers[1]).toMatchObject({
        genre: "Pop",
        url: "https://is1-ssl.mzstatic.com/image/thumb/album-a/1200x1200bb.jpg",
      });
      expect(covers[1]!.preview).toMatch(/^data:image\/jpeg;base64,/);
      // Searched by artist and title, iTunes in the user's store.
      expect(requests).toContain(`${ITUNES}term=RAUM27%20Plattenbaum&entity=song&media=music&limit=25&country=US`);
      expect(decodeURIComponent(requests.find((url) => url.startsWith(MB_GROUPS))!)).toContain(
        'releasegroup:"Plattenbaum" AND artist:"RAUM27"',
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("offers a release from another catalog when the best one's art is missing", () => {
    const { layer } = fakeCatalogs({
      [ITUNES]: { results: [track("RAUM27", "Plattenbaum", "Anfangen Anzufangen", 206, "album-a")] },
      [DEEZER_TRACKS]: {
        data: [
          {
            title: "Plattenbaum",
            duration: 206,
            artist: { name: "RAUM27" },
            album: {
              title: "Anfangen Anzufangen",
              cover_medium: "https://e-cdns-images.dzcdn.net/a/250.jpg",
              cover_xl: "https://e-cdns-images.dzcdn.net/a/1000.jpg",
            },
          },
        ],
      },
      [DEEZER_ALBUMS]: { data: [] },
      // iTunes' art for the album doesn't load; Deezer's does.
      images: ["https://e-cdns-images.dzcdn.net/a/250.jpg"],
    });
    return Effect.gen(function* () {
      const covers = yield* findCovers(SONG);
      expect(covers.map((cover) => [cover.source, cover.album])).toEqual([["deezer", "Anfangen Anzufangen"]]);
    }).pipe(Effect.provide(layer));
  });

  it.live("finds nothing, without failing, when the catalogs can't be reached", () => {
    const { layer } = fakeCatalogs({});
    return Effect.gen(function* () {
      expect(yield* findCovers(SONG)).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
