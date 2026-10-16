import { describe, expect, it } from "vitest";

import type { ProjectChart } from "./chart-mapping";
import { formatMetaTags, parseMetaTags, usdbText, youtubeIdOf } from "./usdb";

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

  it("finds the YouTube video in v, else a, as an id or a link", () => {
    expect(youtubeIdOf([["v", "kPBzTxZQG5Q"]])).toBe("kPBzTxZQG5Q");
    expect(youtubeIdOf([["a", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]])).toBe("dQw4w9WgXcQ");
    expect(youtubeIdOf([["v", "123456789"]])).toBeNull();
  });
});

describe("usdbText", () => {
  it("writes usdb_syncer's headers in its order, without #VERSION, with CRLF line ends", () => {
    const { text, warnings } = usdbText(song(), "RAUM27 - Sommerregen.m4a");
    expect(text.split("\r\n").slice(0, 10)).toEqual([
      "#ARTIST:RAUM27",
      "#TITLE:Sommerregen",
      "#MP3:RAUM27 - Sommerregen.m4a",
      "#CREATOR:Nico",
      "#GENRE:Pop",
      "#YEAR:2019",
      "#LANGUAGE:German",
      "#BPM:300",
      "#GAP:1000",
      "#VIDEO:v=kPBzTxZQG5Q",
    ]);
    expect(text).toContain(": 0 5 2 Fens\r\n: 5 5 2 ter\r\n- 17\r\n: 20 5 2 auf\r\nE\r\n");
    expect(text).not.toMatch(/(?<!\r)\n/);
    expect(warnings).toEqual([]);
  });

  it("rounds BPM to two decimals and GAP to whole milliseconds, and says so", () => {
    const { text, warnings } = usdbText(song({ bpm: 300.123, gap: 1.0004 }), null);
    expect(text).toContain("#BPM:300.12\r\n#GAP:1000\r\n");
    expect(text).not.toContain("#MP3");
    expect(warnings[0]).toMatch(/two decimals/);
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
      null,
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
    const { text } = usdbText(chart, null);
    expect(text).toContain("#TITLE:Sommerregen [DUET]\r\n");
    expect(text).toContain("#VIDEO:v=kPBzTxZQG5Q,p1=Mia,p2=Kai\r\n");
    expect(text).toContain("\r\nP1\r\n");
    expect(text).toContain("\r\nP2\r\n");
  });

  it("warns when usdb_syncer can't know where the audio is", () => {
    const { text, warnings } = usdbText(song({ youtubeId: null }), null);
    expect(text).not.toContain("#VIDEO");
    expect(warnings).toContainEqual(expect.stringContaining("no YouTube video"));
  });
});
