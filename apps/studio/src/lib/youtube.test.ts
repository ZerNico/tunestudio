import { describe, expect, it } from "vitest";

import { parseYoutubeVideoId, suggestSongDetails } from "./youtube";

describe("parseYoutubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/watch?list=PL1&v=dQw4w9WgXcQ&t=42", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("finds the video in %s", (link, id) => {
    expect(parseYoutubeVideoId(link)).toBe(id);
  });

  it("accepts links pasted without a scheme, with surrounding whitespace and any case in the host", () => {
    expect(parseYoutubeVideoId("  youtube.com/watch?v=dQw4w9WgXcQ\n")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeVideoId("YouTu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseYoutubeVideoId("HTTP://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it.each([
    "",
    "   ",
    "not a link",
    "https://www.youtube.com/",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=tooShort",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQextra",
    "https://www.youtube.com/channel/UC1234567890",
    "https://vimeo.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/",
  ])("rejects %j", (text) => {
    expect(parseYoutubeVideoId(text)).toBeNull();
  });
});

describe("suggestSongDetails", () => {
  it.each([
    [
      { title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", channel: "Rick Astley" },
      { artist: "Rick Astley", title: "Never Gonna Give You Up" },
    ],
    [
      { title: "Adele – Hello [Official Music Video] | Adele", channel: "AdeleVEVO" },
      { artist: "Adele", title: "Hello" },
    ],
    [
      { title: 'Queen - "Bohemian Rhapsody" (Lyrics)', channel: "Queen Official" },
      { artist: "Queen", title: "Bohemian Rhapsody" },
    ],
    // Brackets that are part of the song stay.
    [
      { title: "Nena - 99 Luftballons (Remix)", channel: "Nena" },
      { artist: "Nena", title: "99 Luftballons (Remix)" },
    ],
    [
      { title: "Bohemian Rhapsody", channel: "Queen - Topic" },
      { artist: "Queen", title: "Bohemian Rhapsody" },
    ],
    [
      { title: "whatever", channel: "x", artist: "Daft Punk, Pharrell Williams", track: "Get Lucky" },
      { artist: "Daft Punk", title: "Get Lucky" },
    ],
  ])("suggests from %j", (facts, expected) => {
    expect(suggestSongDetails(facts)).toEqual(expected);
  });
});
