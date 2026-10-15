import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { Context, Effect, Layer, Schema } from "effect";

/** How often a download reports its progress. */
const PROGRESS_INTERVAL_MS = 100;
/** A download failed: offline, a server error, or a host that isn't allowed. */
export class DownloadFailed extends Schema.TaggedError<DownloadFailed>()("DownloadFailed", {
  url: Schema.String,
  message: Schema.String,
}) {}

/** Tighter rules for one download than the app-wide host list. */
export interface DownloadLimits {
  /** Only these hosts, for the request and every redirect. */
  readonly hosts?: readonly string[];
  /** Fails once the file grows past this many bytes. */
  readonly maxBytes?: number;
}

interface DownloadsShape {
  /** Fetches and parses a JSON document. */
  readonly json: (url: string) => Effect.Effect<unknown, DownloadFailed>;
  readonly text: (url: string) => Effect.Effect<string, DownloadFailed>;
  /** Where `url` redirects to, without following it (absolute). */
  readonly redirect: (url: string) => Effect.Effect<string, DownloadFailed>;
  /**
   * Streams `url` into `file`, hashing it on the way. `onBytes` gets the bytes received so far
   * and the total when the server sent one.
   */
  readonly file: (
    url: string,
    file: string,
    onBytes: (received: number, total: number | null) => Effect.Effect<void>,
    limits?: DownloadLimits,
  ) => Effect.Effect<{ sha256: string; size: number }, DownloadFailed>;
}

/** HTTPS downloads from a fixed list of hosts. Tests provide their own. */
export class Downloads extends Context.Service<Downloads, DownloadsShape>()("studio/Downloads") {}

/** Where tools come from: GitHub releases (yt-dlp, QuickJS, ffmpeg for Windows and Linux) and macOS ffmpeg builds. */
export const TOOL_HOSTS = [
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "ffmpeg.martin-riedl.de",
];

/** Where YouTube's thumbnails come from (the preview in the new-project dialog). */
export const THUMBNAIL_HOSTS = ["i.ytimg.com"];

/**
 * Where covers come from: the iTunes Search API, Deezer, MusicBrainz with the Cover Art Archive
 * (served from archive.org's storage servers), and their image CDNs. A host starting with a dot
 * allows its subdomains.
 */
export const COVER_HOSTS = [
  "itunes.apple.com",
  ".mzstatic.com",
  "api.deezer.com",
  ".dzcdn.net",
  "musicbrainz.org",
  "coverartarchive.org",
  "archive.org",
  ".archive.org",
];

/** Where models come from: Hugging Face, whose files are served from its CDN. */
export const MODEL_HOSTS = ["huggingface.co", ".hf.co"];

/** Where lyrics come from. */
export const LYRICS_HOSTS = ["lrclib.net"];

/** Whether `host` is on `hosts` (exactly, or as a subdomain of an entry starting with a dot). */
export function hostAllowed(host: string, hosts: readonly string[]): boolean {
  return hosts.some((entry) => (entry.startsWith(".") ? host.endsWith(entry) : host === entry));
}

const USER_AGENT = "TuneStudio";

const failure = (url: string, message: string) => new DownloadFailed({ url, message });

/** Runs a request, turning any failure into a `DownloadFailed` for `url`. */
const attempt = <A>(url: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof DownloadFailed
        ? error
        : failure(url, error instanceof Error ? error.message : "The download failed."),
  });

/** Real downloads with `fetch`. Every request and every redirect must stay on `hosts` (HTTPS only, unless `allowHttp`). */
export function downloadsLayer(options: { hosts: readonly string[]; allowHttp?: boolean }) {
  const allowed = (url: string) => {
    try {
      const parsed = new URL(url);
      const secure = parsed.protocol === "https:" || (options.allowHttp === true && parsed.protocol === "http:");
      return secure && hostAllowed(parsed.hostname, options.hosts);
    } catch {
      return false;
    }
  };

  /** Follows redirects by hand, so each hop is checked against the allowed hosts. */
  const request = (url: string, signal: AbortSignal, follow = true, hosts?: readonly string[]): Promise<Response> =>
    (async () => {
      let current = url;
      for (let hop = 0; hop < 8; hop++) {
        if (!allowed(current) || (hosts && !hostAllowed(new URL(current).hostname, hosts)))
          throw failure(url, `Downloads from ${new URL(current).hostname} aren't allowed.`);
        const response = await fetch(current, { redirect: "manual", signal, headers: { "user-agent": USER_AGENT } });
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          const next = new URL(location, current).toString();
          if (!follow) return new Response(null, { status: 204, headers: { location: next } });
          current = next;
          continue;
        }
        if (!response.ok) throw failure(url, `The server answered ${response.status}.`);
        return response;
      }
      throw failure(url, "Too many redirects.");
    })();

  return Layer.succeed(Downloads, {
    json: (url) => attempt(url, async (signal) => (await request(url, signal)).json() as Promise<unknown>),
    text: (url) => attempt(url, async (signal) => (await request(url, signal)).text()),
    redirect: (url) =>
      attempt(url, async (signal) => {
        const response = await request(url, signal, false);
        const location = response.headers.get("location");
        if (!location) throw failure(url, "The download link didn't point anywhere.");
        return location;
      }),
    file: (url, file, onBytes, limits) =>
      attempt(url, async (signal) => {
        const response = await request(url, signal, true, limits?.hosts);
        if (!response.body) throw failure(url, "The server sent nothing.");
        const total = Number(response.headers.get("content-length")) || null;
        const maxBytes = limits?.maxBytes ?? Infinity;
        const tooLarge = () => failure(url, "The file is larger than expected.");
        if (total !== null && total > maxBytes) {
          await response.body.cancel();
          throw tooLarge();
        }
        const hash = createHash("sha256");
        let received = 0;
        // Progress goes to the renderer: a few times a second is plenty, one message per network chunk
        // (thousands a second) keeps it too busy to even repaint the window.
        let reported = 0;
        // `pipeline` handles errors on both ends (a full disk, a dropped connection) and closes
        // both streams, so a failure ends the download instead of leaving it waiting.
        await pipeline(
          Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
          async function* (chunks: AsyncIterable<Uint8Array>) {
            for await (const chunk of chunks) {
              hash.update(chunk);
              received += chunk.byteLength;
              if (received > maxBytes) throw tooLarge();
              if (Date.now() - reported >= PROGRESS_INTERVAL_MS) {
                reported = Date.now();
                await Effect.runPromise(onBytes(received, total));
              }
              yield chunk;
            }
          },
          createWriteStream(file),
          { signal },
        );
        await Effect.runPromise(onBytes(received, total));
        return { sha256: hash.digest("hex"), size: received };
      }),
  });
}
