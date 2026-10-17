import { Effect, Option } from "effect";

import { CHUNK_SIZE, getMedia, headerMime, readRange } from "../project/media";
import { Projects } from "../project/projects";
import { MEDIA_SCHEME } from "./media-url";

/** A parsed `Range` header: `null` without one, `false` when it can't be satisfied. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | false {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
  return { start, end: Math.min(end, size - 1) };
}

const notFound = () => new Response(null, { status: 404 });

/**
 * Answers a `media://<session>/<media id>` request from an open project, streaming the
 * requested bytes from its chunks. Unknown sessions (closed projects) and media are 404s.
 */
export function mediaResponse(
  request: Request,
  run: <A>(effect: Effect.Effect<A, never, Projects>) => Promise<A>,
): Promise<Response> {
  const url = URL.parse(request.url);
  const mediaId = Number(url?.pathname.slice(1));
  if (!url || url.protocol !== `${MEDIA_SCHEME}:` || !Number.isSafeInteger(mediaId) || url.search) {
    return Promise.resolve(notFound());
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return Promise.resolve(new Response(null, { status: 405 }));

  return run(
    Effect.gen(function* () {
      const projects = yield* Projects;
      const session = yield* projects.get(url.host).pipe(Effect.option);
      if (Option.isNone(session)) return notFound();
      const db = session.value.db;
      const row = yield* getMedia(db, mediaId);
      if (!row) return notFound();

      const headers = new Headers({
        // Files stored before MIME types were checked may have one a header can't hold.
        "Content-Type": headerMime(row.mime),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      const range = parseRange(request.headers.get("Range"), row.size);
      if (range === false) {
        headers.set("Content-Range", `bytes */${row.size}`);
        return new Response(null, { status: 416, headers });
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? row.size - 1;
      headers.set("Content-Length", String(Math.max(0, end - start + 1)));
      if (range) headers.set("Content-Range", `bytes ${start}-${end}/${row.size}`);
      const status = range ? 206 : 200;
      if (request.method === "HEAD" || row.size === 0) return new Response(null, { status, headers });

      // Pull one chunk at a time, so seeking in a long file reads only what is played.
      let next = start;
      const body = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          if (next > end) return controller.close();
          const pieces: Uint8Array[] = [];
          const chunkEnd = Math.min(end, (Math.floor(next / CHUNK_SIZE) + 1) * CHUNK_SIZE - 1);
          await run(readRange(db, mediaId, next, chunkEnd, (bytes) => Effect.sync(() => void pieces.push(bytes))));
          if (pieces.length === 0) return controller.error(new Error("Media chunk missing"));
          for (const piece of pieces) controller.enqueue(piece);
          next = chunkEnd + 1;
        },
      });
      return new Response(body, { status, headers });
    }),
  );
}
