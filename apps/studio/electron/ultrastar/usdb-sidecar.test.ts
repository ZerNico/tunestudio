import { describe, expect, it } from "vitest";

import { usdbSidecarTags } from "./usdb-sidecar";

const txt = { fname: "song.txt" };
const resources = {
  audio: { fname: "song.m4a", resource: "dQw4w9WgXcQ", status: "success" },
  video: { fname: "song.mp4", resource: "https://youtu.be/kPBzTxZQG5Q?si=abc" },
};

describe("USDB sidecars", () => {
  it.each([undefined, null])("falls back to download resources only without metadata: %s", (meta_tags) => {
    const text = JSON.stringify({ version: 1, txt, meta_tags, ...resources });
    expect(usdbSidecarTags(text, "song.txt")).toEqual([
      ["v", "kPBzTxZQG5Q"],
      ["a", "dQw4w9WgXcQ"],
    ]);
    expect(usdbSidecarTags(text, "other.txt")).toBeNull();
  });

  it.each([
    ["a=rl0IjlamWPI", [["a", "rl0IjlamWPI"]]],
    ["v=rl0IjlamWPI", [["v", "rl0IjlamWPI"]]],
    [
      "co=cover.jpg,preview=12.5",
      [
        ["co", "cover.jpg"],
        ["preview", "12.5"],
      ],
    ],
    ["", []],
    [
      "v=rl0IjlamWPI,a=dQw4w9WgXcQ",
      [
        ["v", "rl0IjlamWPI"],
        ["a", "dQw4w9WgXcQ"],
      ],
    ],
  ])("doesn't add download-history sources to declared metadata: %s", (meta_tags, expected) => {
    expect(usdbSidecarTags(JSON.stringify({ version: 1, txt, meta_tags, ...resources }), "song.txt")).toEqual(expected);
  });

  it.each([undefined, null, {}, { status: "failed" }])("ignores sidecars without a chart filename: %j", (txt) => {
    expect(usdbSidecarTags(JSON.stringify({ version: 1, txt }), "song.txt")).toBeNull();
  });

  it.each([
    {},
    { audio: null, video: null },
    { audio: { status: "skipped_unavailable" }, video: { status: "failed" } },
    { audio: { resource: "not a YouTube ID" }, video: { resource: "https://example.com/video" } },
  ])("tolerates missing and unavailable resources: %j", (resources) => {
    expect(usdbSidecarTags(JSON.stringify({ version: 1, txt, ...resources }), "song.txt")).toEqual([]);
  });

  it.each(["{", "null", "[]", JSON.stringify({ version: 2, txt })])(
    "refuses malformed or unsupported sidecars: %s",
    (text) => {
      expect(() => usdbSidecarTags(text, "song.txt")).toThrow();
    },
  );
});
