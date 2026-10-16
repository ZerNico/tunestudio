import { asc } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { ProjectDamaged } from "../errors";
import type { ChartLineRow, ChartSingerRow, ProjectChart } from "../ultrastar/chart-mapping";
import type { Queryable } from "./database";
import { ExtraHeaders, Languages, lines, notes, singers, song } from "./schema";

const encodeLanguages = Schema.encodeSync(Languages);
const encodeExtraHeaders = Schema.encodeSync(ExtraHeaders);
const decodeLanguages = Schema.decodeUnknownEffect(Languages);
const decodeExtraHeaders = Schema.decodeUnknownEffect(ExtraHeaders);

/** Writes the song and its singers, lines and notes into an empty project. */
export function writeChart(db: Queryable, chart: ProjectChart) {
  return Effect.gen(function* () {
    const { language, extraHeaders, ...details } = chart.song;
    yield* db.insert(song).values({
      id: 1,
      ...details,
      language: encodeLanguages(language),
      extraHeaders: encodeExtraHeaders(extraHeaders),
    });
    yield* writeSingers(db, chart.singers);
  });
}

/**
 * Replaces the project's singers, lines and notes with `chart`'s, and its grid (BPM and GAP) with `chart`'s; the
 * other song details stay. Run it in a transaction: it deletes before it writes.
 */
export function replaceChart(
  db: Queryable,
  chart: Pick<ProjectChart, "singers"> & { song: { bpm: number; gap: number } },
) {
  return Effect.gen(function* () {
    // Lines and notes go with their singers.
    yield* db.delete(singers);
    yield* db.update(song).set({ bpm: chart.song.bpm, gap: chart.song.gap });
    yield* writeSingers(db, chart.singers);
  });
}

function writeSingers(db: Queryable, chartSingers: readonly ChartSingerRow[]) {
  return Effect.gen(function* () {
    for (const singer of chartSingers) {
      const [singerRow] = yield* db
        .insert(singers)
        .values({ index: singer.index, name: singer.name })
        .returning({ id: singers.id });
      for (const [position, line] of singer.lines.entries()) {
        const [lineRow] = yield* db
          .insert(lines)
          .values({ singerId: singerRow!.id, position, switchStart: line.switchStart, switchEnd: line.switchEnd })
          .returning({ id: lines.id });
        if (line.notes.length > 0) {
          yield* db.insert(notes).values(
            line.notes.map((note, notePosition) => ({
              start: note.start,
              duration: note.duration,
              pitch: note.pitch,
              lyric: note.lyric,
              type: note.type,
              lineId: lineRow!.id,
              position: notePosition,
            })),
          );
        }
      }
    }
  });
}

const damaged = () => new ProjectDamaged({ message: "The project's song details are damaged." });

/**
 * The project's song details, its JSON columns decoded. One that doesn't decode means a damaged file: reading it as
 * empty would lose what it holds the next time the details are saved.
 */
export function readSong(db: Queryable) {
  return Effect.gen(function* () {
    const [songRow] = yield* db.select().from(song).limit(1).pipe(Effect.orDie);
    if (!songRow)
      return yield* new ProjectDamaged({ message: "The project is missing its song details. It may be damaged." });
    const language = yield* decodeLanguages(songRow.language).pipe(Effect.mapError(damaged));
    const extraHeaders = yield* decodeExtraHeaders(songRow.extraHeaders).pipe(Effect.mapError(damaged));
    return { songRow, language, extraHeaders };
  });
}

/** Reads the project's chart back. */
export function readChart(db: Queryable): Effect.Effect<ProjectChart, ProjectDamaged> {
  return Effect.gen(function* () {
    const { songRow, language, extraHeaders } = yield* readSong(db);

    const singerRows = yield* db.select().from(singers).orderBy(asc(singers.index)).pipe(Effect.orDie);
    const lineRows = yield* db
      .select()
      .from(lines)
      .orderBy(asc(lines.singerId), asc(lines.position))
      .pipe(Effect.orDie);
    const noteRows = yield* db.select().from(notes).orderBy(asc(notes.lineId), asc(notes.position)).pipe(Effect.orDie);

    const linesById = new Map<number, ChartLineRow>();
    const linesBySinger = new Map<number, ChartLineRow[]>();
    for (const row of lineRows) {
      const line: ChartLineRow = { switchStart: row.switchStart, switchEnd: row.switchEnd, notes: [] };
      linesById.set(row.id, line);
      linesBySinger.set(row.singerId, [...(linesBySinger.get(row.singerId) ?? []), line]);
    }
    for (const row of noteRows) {
      linesById.get(row.lineId)?.notes.push({
        start: row.start,
        duration: row.duration,
        pitch: row.pitch,
        lyric: row.lyric,
        type: row.type,
      });
    }
    const chartSingers: ChartSingerRow[] = singerRows.map((row) => ({
      index: row.index,
      name: row.name,
      lines: linesBySinger.get(row.id) ?? [],
    }));
    const { id: _id, language: _language, extraHeaders: _extra, ...details } = songRow;
    return {
      song: { ...details, language: [...language], extraHeaders: extraHeaders.map(([key, value]) => [key, value]) },
      singers: chartSingers,
    };
  });
}
