import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { CHUNK_SIZE, listMedia } from "../project/media";
import { Projects } from "../project/projects";
import { soloChart, syntheticBytes, tempDir, testRuntime, writeSong } from "../testing";
import { importSong, inspectSong } from "../ultrastar/song-import";
import { mediaResponse, parseRange } from "./media";
import { mediaUrl } from "./media-url";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups = [];
});

const audio = syntheticBytes(2 * CHUNK_SIZE + 999, 21);

/** An open project with one audio file, and a `fetch` for its media URLs. */
async function setup() {
  const { dir, cleanup } = tempDir();
  const { runtime } = testRuntime(dir);
  cleanups.push(cleanup, () => runtime.dispose());
  const folder = writeSong(dir, "Song", { "song.txt": soloChart(), "Test Artist - Night Signals.mp3": audio });
  const { session, mediaId } = await runtime.runPromise(
    Effect.gen(function* () {
      const session = yield* importSong(yield* inspectSong(folder), {
        includeVideo: true,
        target: path.join(dir, "p.tunestudio"),
      });
      return { session, mediaId: (yield* listMedia(session.db))[0]!.id };
    }),
  );
  const fetchMedia = (url: string, init?: RequestInit) =>
    mediaResponse(new Request(url, init), (effect) => runtime.runPromise(effect));
  return { runtime, session, url: mediaUrl(session.id, mediaId), fetchMedia };
}

const body = async (response: Response) => Buffer.from(await response.arrayBuffer());

describe("media:// protocol", () => {
  it("serves a whole file with its type and length", async () => {
    const { url, fetchMedia } = await setup();
    const response = await fetchMedia(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Length")).toBe(String(audio.length));
    expect((await body(response)).equals(audio)).toBe(true);
  });

  it.each([
    ["bytes=0-0", 0, 0],
    ["bytes=10-2000000", 10, 2_000_000],
    [`bytes=${CHUNK_SIZE - 5}-${CHUNK_SIZE + 5}`, CHUNK_SIZE - 5, CHUNK_SIZE + 5],
    [`bytes=${2 * CHUNK_SIZE}-`, 2 * CHUNK_SIZE, 2 * CHUNK_SIZE + 998],
    ["bytes=-100", 2 * CHUNK_SIZE + 899, 2 * CHUNK_SIZE + 998],
    ["bytes=5-999999999", 5, 2 * CHUNK_SIZE + 998],
  ])("answers Range %s with 206 and exactly those bytes", async (range, start, end) => {
    const { url, fetchMedia } = await setup();
    const response = await fetchMedia(url, { headers: { Range: range } });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes ${start}-${end}/${audio.length}`);
    expect(response.headers.get("Content-Length")).toBe(String(end - start + 1));
    expect((await body(response)).equals(audio.subarray(start, end + 1))).toBe(true);
  });

  it("rejects ranges it can't satisfy, other methods and HEAD bodies", async () => {
    const { url, fetchMedia } = await setup();
    const outside = await fetchMedia(url, { headers: { Range: `bytes=${audio.length}-` } });
    expect(outside.status).toBe(416);
    expect(outside.headers.get("Content-Range")).toBe(`bytes */${audio.length}`);
    expect((await fetchMedia(url, { method: "POST" })).status).toBe(405);
    const head = await fetchMedia(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(audio.length));
    expect(await head.text()).toBe("");
  });

  it("serves nothing for unknown media, unknown sessions and closed projects", async () => {
    const { url, session, runtime, fetchMedia } = await setup();
    expect((await fetchMedia(mediaUrl(session.id, 999))).status).toBe(404);
    expect((await fetchMedia(mediaUrl("00000000-0000-0000-0000-000000000000", 1))).status).toBe(404);
    expect((await fetchMedia(`${url}?x=1`)).status).toBe(404);
    expect((await fetchMedia("media://x/../../etc/passwd")).status).toBe(404);
    await runtime.runPromise(Projects.use((projects) => projects.close(session.id)));
    expect((await fetchMedia(url)).status).toBe(404);
  });
});

describe("parseRange", () => {
  it("parses single byte ranges and refuses the rest", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=10-20", 100)).toEqual({ start: 10, end: 20 });
    expect(parseRange("bytes=95-200", 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange("bytes=25-", 100)).toEqual({ start: 25, end: 99 });
    expect(parseRange("bytes=-15", 100)).toEqual({ start: 85, end: 99 });
    for (const value of [
      "bytes=100-",
      "bytes=30-20",
      "bytes=-",
      "bytes=0-1,4-5",
      "junk",
      "bytes=999999999999999999999-",
    ]) {
      expect(parseRange(value, 100)).toBe(false);
    }
    expect(parseRange("bytes=0-", 0)).toBe(false);
  });
});
