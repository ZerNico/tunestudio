/** The chart as the editor sees it: every singer, line and note with its row id, so edits can address them. */
import { asc } from "drizzle-orm";
import { Effect } from "effect";

import type { EditorChart, EditorLine, EditorNote, EditorSinger } from "../../src/lib/native/types";
import type { ProjectDamaged } from "../errors";
import { readSong } from "./chart";
import type { Queryable } from "./database";
import { lines, notes, singers } from "./schema";
import { tagsOf, withoutTags } from "./tags";

/** The project's singers, lines and notes in order, with the grid (#BPM and #GAP) they are exported on. */
export function readEditorChart(db: Queryable): Effect.Effect<EditorChart, ProjectDamaged> {
  return Effect.gen(function* () {
    const { songRow, language, extraHeaders: headers } = yield* readSong(db);
    const singerRows = yield* db.select().from(singers).orderBy(asc(singers.index)).pipe(Effect.orDie);
    const lineRows = yield* db
      .select()
      .from(lines)
      .orderBy(asc(lines.singerId), asc(lines.position))
      .pipe(Effect.orDie);
    const noteRows = yield* db.select().from(notes).orderBy(asc(notes.lineId), asc(notes.position)).pipe(Effect.orDie);

    const linesById = new Map<number, EditorLine & { notes: EditorNote[] }>();
    const bySinger = new Map<number, EditorLine[]>();
    for (const row of lineRows) {
      const line = { id: row.id, switchStart: row.switchStart, switchEnd: row.switchEnd, notes: [] as EditorNote[] };
      linesById.set(row.id, line);
      bySinger.set(row.singerId, [...(bySinger.get(row.singerId) ?? []), line]);
    }
    for (const row of noteRows) {
      linesById.get(row.lineId)?.notes.push({
        id: row.id,
        start: row.start,
        duration: row.duration,
        pitch: row.pitch,
        lyric: row.lyric,
        type: row.type,
        edited: row.edited,
      });
    }
    const editorSingers: EditorSinger[] = singerRows.map((row) => ({
      id: row.id,
      index: row.index,
      name: row.name,
      lines: bySinger.get(row.id) ?? [],
    }));
    return {
      bpm: songRow.bpm,
      gap: songRow.gap,
      song: {
        title: songRow.title,
        artist: songRow.artist,
        language,
        year: songRow.year,
        genre: songRow.genre,
        edition: songRow.edition,
        creator: songRow.creator,
        tags: tagsOf(headers),
        otherHeaders: withoutTags(headers),
        videoGap: songRow.videoGap,
        start: songRow.start,
        end: songRow.end,
        previewStart: songRow.previewStart,
        medleyStart: songRow.medleyStart,
        medleyEnd: songRow.medleyEnd,
      },
      singers: editorSingers,
    };
  });
}
