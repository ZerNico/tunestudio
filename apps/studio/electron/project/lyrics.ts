import { desc, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { ProjectLyrics } from "../../src/lib/native/contract";
import type { LyricsLine } from "../../src/lib/native/types";
import type { Queryable } from "./database";
import type { MediaRow } from "./media";
import { analysis } from "./schema";

/*
 * The song's lyrics, as `analysis` of kind "lyrics" on the main audio (docs/project-format.md):
 * JSON `{ lines: [{ start, text }] }`, with `start` in seconds for synced lyrics and null
 * otherwise. The producer says where they came from: "lrclib", "whisper" or "user".
 */

const LyricsData = Schema.fromJsonString(
  Schema.Struct({
    lines: Schema.Array(Schema.Struct({ start: Schema.NullOr(Schema.Number), text: Schema.String })),
  }),
);
const encodeLyrics = Schema.encodeSync(LyricsData);
const decodeLyrics = Schema.decodeUnknownEffect(LyricsData);

/** Stores lyrics for `audio`. */
export function writeLyrics(db: Queryable, audio: MediaRow, lyrics: ProjectLyrics) {
  return db.insert(analysis).values({
    kind: "lyrics",
    inputMediaId: audio.id,
    inputSha256: audio.sha256,
    producer: lyrics.source,
    producerVersion: "1",
    params: JSON.stringify({
      ...(lyrics.lrclibId === undefined ? {} : { lrclibId: lyrics.lrclibId }),
      ...(lyrics.language === undefined ? {} : { language: lyrics.language }),
      ...(lyrics.mixed ? { mixed: true } : {}),
    }),
    encoding: "json",
    data: Buffer.from(encodeLyrics({ lines: lyrics.lines })),
  });
}

/** The newest lyrics in the project, or null; lyrics that don't decode count as none. */
export function readLyrics(
  db: Queryable,
): Effect.Effect<{ source: string; synced: boolean; lines: LyricsLine[] } | null> {
  return Effect.gen(function* () {
    const [row] = yield* db
      .select()
      .from(analysis)
      .where(eq(analysis.kind, "lyrics"))
      .orderBy(desc(analysis.id))
      .limit(1)
      .pipe(Effect.orDie);
    if (!row) return null;
    const decoded = yield* decodeLyrics(Buffer.from(row.data).toString("utf8")).pipe(Effect.option);
    if (decoded._tag === "None") return null;
    const lines = decoded.value.lines.map((line) => ({ start: line.start, text: line.text }));
    return { source: row.producer, synced: lines.length > 0 && lines.every((line) => line.start !== null), lines };
  });
}
