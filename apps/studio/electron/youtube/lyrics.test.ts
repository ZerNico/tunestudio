import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { DownloadFailed, Downloads } from "../tools/downloads";
import { findLyrics, parseLrc, pickLyrics, plainLines } from "./lyrics";

const entry = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  trackName: "Sommerregen",
  artistName: "RAUM27",
  albumName: "Anfangen Anzufangen",
  duration: 231,
  instrumental: false,
  plainLyrics: "Ahh-ahh\nFenster auf kipp",
  syncedLyrics: "[00:10.92] Ahh-ahh\n[00:16.77] Fenster auf kipp",
  ...overrides,
});

const SONG = { artist: "RAUM27", title: "Sommerregen", duration: 231 };

describe("LRC", () => {
  it("reads timed lines, repeats a line once per timestamp, and drops breaks", () => {
    expect(parseLrc("[00:10.92] Ahh-ahh\n[00:16.77]\n[01:02.50][00:20.00] Chorus\n")).toEqual([
      { start: 10.92, text: "Ahh-ahh" },
      { start: 20, text: "Chorus" },
      { start: 62.5, text: "Chorus" },
    ]);
    expect(plainLines("One\n\n Two \n")).toEqual([
      { start: null, text: "One" },
      { start: null, text: "Two" },
    ]);
  });
});

describe("pickLyrics", () => {
  it("takes the synced version closest to the video's length, never another version or song", () => {
    const picked = pickLyrics(
      [
        entry(1, { duration: 225 }),
        entry(2, { duration: 230 }),
        entry(3, { duration: 231, syncedLyrics: null }),
        entry(4, { trackName: "Sommerregen (Paused)", duration: 231 }),
        entry(5, { trackName: "Sommergewitter", duration: 231 }),
        entry(6, { artistName: "Someone Else", duration: 231 }),
      ],
      SONG,
    );
    expect(picked?.id).toBe(2);
  });

  it("takes the exact title over a synced song that only contains it", () => {
    const time = { artist: "Pink Floyd", title: "Time", duration: 413 };
    const picked = pickLyrics(
      [
        entry(1, { artistName: "Pink Floyd", trackName: "Biding My Time", duration: 330 }),
        entry(2, { artistName: "Pink Floyd", trackName: "Time", duration: 413, syncedLyrics: null }),
      ],
      time,
    );
    expect(picked?.id).toBe(2);
  });

  it("uses studio lyrics when the requested live or acoustic version is missing", () => {
    for (const title of ["Sommerregen (Live)", "Sommerregen - Live at Wembley", "Sommerregen (Acoustic)"]) {
      expect(pickLyrics([entry(1)], { ...SONG, title })?.id).toBe(1);
    }
  });

  it("prefers the requested version even when studio lyrics are synced and closer in length", () => {
    const title = "Sommerregen (Live)";
    expect(
      pickLyrics([entry(1), entry(2, { trackName: title, syncedLyrics: null, duration: 300 })], { ...SONG, title })?.id,
    ).toBe(2);
  });

  it("doesn't substitute a remix, another song, another artist, or an empty instrumental", () => {
    const candidates = [
      entry(1, { trackName: "Sommerregen (Club Remix)" }),
      entry(2, { trackName: "Nach dem Sommerregen" }),
      entry(3, { artistName: "Someone Else" }),
      entry(4, { instrumental: true, syncedLyrics: null, plainLyrics: null }),
    ];
    expect(pickLyrics(candidates, { ...SONG, title: "Sommerregen (Live)" })).toBeUndefined();
    expect(pickLyrics([entry(5, { trackName: "Sommerregen (Live)" })], SONG)).toBeUndefined();
  });
});

describe("findLyrics", () => {
  const lrclib = (answer: unknown) =>
    Layer.succeed(Downloads, {
      json: (url) =>
        answer === undefined
          ? Effect.fail(new DownloadFailed({ url, message: "No connection." }))
          : Effect.succeed(answer),
      text: (url) => Effect.fail(new DownloadFailed({ url, message: "No." })),
      redirect: (url) => Effect.fail(new DownloadFailed({ url, message: "No." })),
      file: (url) => Effect.fail(new DownloadFailed({ url, message: "No." })),
    });

  it.effect("returns the picked entry's lines", () =>
    Effect.gen(function* () {
      expect(yield* findLyrics(SONG)).toEqual({
        source: "lrclib",
        id: 9,
        artist: "RAUM27",
        title: "Sommerregen",
        album: "Anfangen Anzufangen",
        duration: 231,
        synced: true,
        instrumental: false,
        versionMismatch: false,
        lines: [
          { start: 10.92, text: "Ahh-ahh" },
          { start: 16.77, text: "Fenster auf kipp" },
        ],
      });
    }).pipe(Effect.provide(lrclib([entry(9)]))),
  );

  it.effect("searches the base title when the live lookup is empty and marks the fallback", () => {
    const titles: string[] = [];
    const downloads = Layer.succeed(Downloads, {
      text: (url) => Effect.fail(new DownloadFailed({ url, message: "No." })),
      redirect: (url) => Effect.fail(new DownloadFailed({ url, message: "No." })),
      file: (url) => Effect.fail(new DownloadFailed({ url, message: "No." })),
      json: (url) => {
        const title = new URL(url).searchParams.get("track_name")!;
        titles.push(title);
        return Effect.succeed(title === SONG.title ? [entry(9)] : []);
      },
    });
    return Effect.gen(function* () {
      const found = yield* findLyrics({ ...SONG, title: "Sommerregen (Live)" });
      expect(titles).toEqual(["Sommerregen (Live)", "Sommerregen"]);
      expect(found).toMatchObject({ id: 9, title: "Sommerregen", versionMismatch: true });
      expect(found?.lines).toHaveLength(2);
    }).pipe(Effect.provide(downloads));
  });

  it.effect("doesn't mark lyrics for the requested live version as a fallback", () =>
    Effect.gen(function* () {
      const found = yield* findLyrics({ ...SONG, title: "Sommerregen (Live)" });
      expect(found).toMatchObject({ id: 2, versionMismatch: false });
    }).pipe(Effect.provide(lrclib([entry(1), entry(2, { trackName: "Sommerregen (Live)" })]))),
  );

  it.effect("is null when LRCLIB has nothing", () =>
    Effect.gen(function* () {
      expect(yield* findLyrics(SONG).pipe(Effect.provide(lrclib([])))).toBeNull();
    }),
  );

  it.live("says when LRCLIB can't be reached, after trying again", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(findLyrics(SONG).pipe(Effect.provide(lrclib(undefined))));
      expect(error).toMatchObject({
        _tag: "LyricsUnavailable",
        message: "LRCLIB can't be reached right now. Try again in a moment.",
      });
    }),
  );
});
