import { describe, expect, it } from "vitest";

import { dropKind, isAudioFile, summarizeAudioFile } from "./import-files";

describe("summarizeAudioFile", () => {
  it("splits an 'Artist - Title' file name", () => {
    expect(summarizeAudioFile({ name: "Raum27 - Oft gesagt.mp3", size: 42 })).toEqual({
      name: "Raum27 - Oft gesagt.mp3",
      size: 42,
      format: "MP3",
      artist: "Raum27",
      title: "Oft gesagt",
    });
  });

  it("uses the whole name as the title when there is no artist", () => {
    expect(summarizeAudioFile({ name: "demo take.Flac", size: 1 })).toMatchObject({
      format: "FLAC",
      artist: "",
      title: "demo take",
    });
  });
});

describe("isAudioFile", () => {
  it("goes by extension, case-insensitively", () => {
    expect(isAudioFile("song.OPUS")).toBe(true);
    expect(isAudioFile("song.txt")).toBe(false);
    expect(isAudioFile("mp3")).toBe(false);
  });
});

describe("dropKind", () => {
  it("opens projects, imports folders and charts, and starts audio projects", () => {
    expect(dropKind("Song.tunestudio", false)).toBe("project");
    expect(dropKind("Song", true)).toBe("song");
    expect(dropKind("Song.TXT", false)).toBe("song");
    expect(dropKind("Song.mp3", false)).toBe("audio");
    expect(dropKind("Song.pdf", false)).toBe("unknown");
    expect(dropKind("Song.tunestudio", true)).toBe("song");
  });
});
