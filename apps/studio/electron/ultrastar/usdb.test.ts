import { describe, expect, it } from "vitest";

import type { ProjectChart } from "./chart-mapping";
import { formatMetaTags, parseMetaTags, youtubeIdOf } from "./meta-tags";
import { readMetaTags, usdbText } from "./usdb";

const NONE = { audio: null, cover: null, background: null };

const note = (start: number, lyric: string) => ({ start, duration: 0.25, pitch: 62, lyric, type: "normal" as const });

/** A song at 300 BPM (a beat is 50 ms), GAP 1 s. */
function song(change: Partial<ProjectChart["song"]> = {}): ProjectChart {
  return {
    song: {
      title: "Sommerregen",
      artist: "RAUM27",
      language: ["German"],
      year: 2019,
      genre: "Pop",
      edition: null,
      creator: "Nico",
      bpm: 300,
      gap: 1,
      videoGap: null,
      start: null,
      end: null,
      previewStart: null,
      medleyStart: null,
      medleyEnd: null,
      extraHeaders: [],
      youtubeId: "kPBzTxZQG5Q",
      youtubeAudioId: null,
      ...change,
    },
    singers: [
      {
        index: 1,
        name: null,
        lines: [
          { switchStart: null, switchEnd: null, notes: [note(1, "Fens"), note(1.25, "ter")] },
          { switchStart: null, switchEnd: null, notes: [note(2, "auf")] },
        ],
      },
    ],
  };
}

describe("meta tags", () => {
  it("reads and writes usdb_syncer's #VIDEO tags, with commas in values escaped", () => {
    const tags = parseMetaTags("v=kPBzTxZQG5Q,co=https://example.com/a.jpg,CO-CROP=24-53-884-884,tags=explicit%2C80s");
    expect(tags).toEqual([
      ["v", "kPBzTxZQG5Q"],
      ["co", "https://example.com/a.jpg"],
      ["co-crop", "24-53-884-884"],
      ["tags", "explicit,80s"],
    ]);
    expect(formatMetaTags(tags!)).toBe(
      "v=kPBzTxZQG5Q,co=https://example.com/a.jpg,co-crop=24-53-884-884,tags=explicit%2C80s",
    );
    expect(parseMetaTags("Song.mp4")).toBeNull();
  });

  it("reads each YouTube source separately, as an id or a link", () => {
    const tags = parseMetaTags("v=kPBzTxZQG5Q,a=https://www.youtube.com/watch?v=dQw4w9WgXcQ")!;
    expect(youtubeIdOf(tags, "v")).toBe("kPBzTxZQG5Q");
    expect(youtubeIdOf(tags, "a")).toBe("dQw4w9WgXcQ");
    expect(youtubeIdOf([["v", "123456789"]], "v")).toBeNull();
    expect(youtubeIdOf([["a", "dQw4w9WgXcQ"]], "v")).toBeNull();
  });
});

describe("readMetaTags", () => {
  it("takes what USDB keeps in the meta tags as the song's own, where its headers don't say", () => {
    const chart = song({ youtubeId: null, previewStart: 7 });
    readMetaTags(chart, parseMetaTags("v=rl0IjlamWPI,preview=50.73,medley=0-1532,p1=Mia,tags=live%2C80s")!);
    // 300 BPM: a beat is 50 ms, from GAP at 1 s.
    expect(chart.song).toMatchObject({ youtubeId: "rl0IjlamWPI", previewStart: 7, medleyStart: 1 });
    expect(chart.song.medleyEnd).toBeCloseTo(77.6, 9);
    expect(chart.singers[0]!.name).toBe("Mia");
    expect(chart.song.extraHeaders).toContainEqual(["TAGS", "live, 80s"]);
  });
});

describe("YouTube sources", () => {
  it.each([
    ["v=kPBzTxZQG5Q", "kPBzTxZQG5Q", null],
    ["a=dQw4w9WgXcQ", null, "dQw4w9WgXcQ"],
    ["a=dQw4w9WgXcQ,v=kPBzTxZQG5Q", "kPBzTxZQG5Q", "dQw4w9WgXcQ"],
    ["a=kPBzTxZQG5Q,v=kPBzTxZQG5Q", "kPBzTxZQG5Q", null],
  ])("imports and exports %s without confusing audio and video", (value, youtubeId, youtubeAudioId) => {
    const chart = song({ youtubeId: null, extraHeaders: [["VIDEO", value]] });
    readMetaTags(chart, parseMetaTags(value)!);
    expect(chart.song).toMatchObject({ youtubeId, youtubeAudioId });
    const { text, warnings } = usdbText(chart, NONE);
    const expected = youtubeAudioId ? `a=${youtubeAudioId}${youtubeId ? `,v=${youtubeId}` : ""}` : `v=${youtubeId}`;
    expect(text).toContain(`#VIDEO:${expected}\r\n`);
    expect(warnings).toEqual([]);
  });

  it("uses edited source IDs and never restores a cleared source from preserved metadata", () => {
    const chart = song({
      youtubeAudioId: "rl0IjlamWPI",
      extraHeaders: [["VIDEO", "a=oldaudio123,v=oldvideo123,co=cover.jpg"]],
    });
    expect(usdbText(chart, NONE).text).toContain("#VIDEO:a=rl0IjlamWPI,v=kPBzTxZQG5Q,co=cover.jpg\r\n");
    chart.song.youtubeAudioId = null;
    expect(usdbText(chart, NONE).text).toContain("#VIDEO:v=kPBzTxZQG5Q,co=cover.jpg\r\n");
    chart.song.youtubeId = null;
    const { text, warnings } = usdbText(chart, NONE);
    expect(text).toContain("#VIDEO:co=cover.jpg\r\n");
    expect(warnings).toEqual(["The song has no YouTube source."]);
  });
});

describe("usdbText", () => {
  it("writes usdb_syncer's headers in its order, without #VERSION, with CRLF line ends", () => {
    const { text, warnings } = usdbText(song(), {
      ...NONE,
      audio: "RAUM27 - Sommerregen.m4a",
      cover: "RAUM27 - Sommerregen [CO].jpg",
    });
    expect(text.split("\r\n").slice(0, 11)).toEqual([
      "#ARTIST:RAUM27",
      "#TITLE:Sommerregen",
      "#MP3:RAUM27 - Sommerregen.m4a",
      "#CREATOR:Nico",
      "#COVER:RAUM27 - Sommerregen [CO].jpg",
      "#GENRE:Pop",
      "#YEAR:2019",
      "#LANGUAGE:German",
      "#BPM:300",
      "#GAP:1000",
      "#VIDEO:v=kPBzTxZQG5Q",
    ]);
    expect(text).toMatch(/: 0 5 2 Fens\r\n: 5 5 2 ter\r\n- 17\r\n: 20 5 2 auf\r\nE$/);
    expect(text).not.toMatch(/(?<!\r)\n/);
    expect(warnings).toEqual([]);
  });

  it("rounds BPM to two decimals and GAP to whole milliseconds", () => {
    const { text } = usdbText(song({ bpm: 300.123, gap: 1.0004 }), NONE);
    expect(text).toContain("#BPM:300.12\r\n#GAP:1000\r\n");
    expect(text).not.toContain("#MP3");
  });

  it("puts preview, medley and tags in the meta tags, keeping a USDB chart's cover there", () => {
    const { text } = usdbText(
      song({
        previewStart: 12.5,
        medleyStart: 1,
        medleyEnd: 2.25,
        extraHeaders: [
          ["VIDEO", "v=oldvideo123,co=here-without-you-5ce7555adf766.jpg,preview=3"],
          ["TAGS", "live, acoustic"],
        ],
      }),
      NONE,
    );
    expect(text).toContain(
      "#VIDEO:v=kPBzTxZQG5Q,co=here-without-you-5ce7555adf766.jpg,preview=12.5,medley=0-25,tags=live%2Cacoustic\r\n",
    );
    // What USDB drops isn't written as headers.
    expect(text).not.toMatch(/#(PREVIEWSTART|MEDLEYSTARTBEAT|TAGS|VERSION):/);
  });

  it("marks a duet in the title and names its singers in the meta tags", () => {
    const chart = song();
    chart.singers = [
      { ...chart.singers[0]!, name: "Mia" },
      { index: 2, name: "Kai", lines: [{ switchStart: null, switchEnd: null, notes: [note(3, "la")] }] },
    ];
    const { text } = usdbText(chart, NONE);
    expect(text).toContain("#TITLE:Sommerregen [DUET]\r\n");
    expect(text).toContain("#VIDEO:v=kPBzTxZQG5Q,p1=Mia,p2=Kai\r\n");
    expect(text).toContain("\r\nP1\r\n");
    expect(text).toContain("\r\nP2\r\n");
  });

  it("warns when usdb_syncer can't know where the audio is", () => {
    const { text, warnings } = usdbText(song({ youtubeId: null }), NONE);
    expect(text).not.toContain("#VIDEO");
    expect(warnings).toContainEqual(expect.stringContaining("no YouTube source"));
  });
});
