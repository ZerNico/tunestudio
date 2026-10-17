/**
 * Writes the editor's edits: each edit (or its undo) is a list of row changes with the rows as they were and as they
 * become. Every `before` is checked against the file first, so an editor out of step with the project fails the whole
 * edit instead of writing over something it didn't see. Afterwards notes and lines are put back in order (positions),
 * so edits never have to keep track of it.
 */
import { asc, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { ChartChange, LineFields, NoteFields, SingerFields, SongFields } from "../../src/lib/native/contract";
import { ChartOutOfStep } from "../errors";
import { readSong } from "./chart";
import { orDiskFull, type Queryable } from "./database";
import { ExtraHeaders, Languages, lines, notes, singers, song } from "./schema";
import { tagsOf, withTags } from "./tags";

const encodeLanguages = Schema.encodeSync(Languages);
const encodeExtraHeaders = Schema.encodeSync(ExtraHeaders);

/** The file isn't as the editor thinks: the edit isn't written. */
const outOfStep = () =>
  new ChartOutOfStep({ message: "The edit couldn't be saved. The project file was changed meanwhile." });

/** Whether every field of `expected` has that value in `row`. */
function matches(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => JSON.stringify(row[key]) === JSON.stringify(value));
}

function noteChange(db: Queryable, id: number, before: NoteFields | null, after: NoteFields | null) {
  return Effect.gen(function* () {
    const [row] = yield* db.select().from(notes).where(eq(notes.id, id)).limit(1).pipe(Effect.orDie);
    if (before ? !row || !matches(row, before) : row) return yield* outOfStep();
    if (!after) {
      yield* db.delete(notes).where(eq(notes.id, id)).pipe(orDiskFull);
    } else if (!before) {
      // Its position is set when the lines are put back in order.
      yield* db
        .insert(notes)
        .values({ id, ...after, position: 0 })
        .pipe(orDiskFull);
    } else {
      yield* db.update(notes).set(after).where(eq(notes.id, id)).pipe(orDiskFull);
    }
  });
}

function lineChange(db: Queryable, id: number, before: LineFields | null, after: LineFields | null) {
  return Effect.gen(function* () {
    const [row] = yield* db.select().from(lines).where(eq(lines.id, id)).limit(1).pipe(Effect.orDie);
    if (before ? !row || !matches(row, before) : row) return yield* outOfStep();
    if (!after) {
      // A line is deleted after its notes (or they were moved): deleting it would take them along unseen.
      const [left] = yield* db
        .select({ id: notes.id })
        .from(notes)
        .where(eq(notes.lineId, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (left) return yield* outOfStep();
      yield* db.delete(lines).where(eq(lines.id, id)).pipe(orDiskFull);
    } else if (!before) {
      yield* db
        .insert(lines)
        .values({ id, ...after, position: 0 })
        .pipe(orDiskFull);
    } else {
      yield* db.update(lines).set(after).where(eq(lines.id, id)).pipe(orDiskFull);
    }
  });
}

function songChange(db: Queryable, before: SongFields, after: SongFields) {
  return Effect.gen(function* () {
    const { songRow, language: stored, extraHeaders: headers } = yield* readSong(db);
    const current = { ...songRow, language: stored, tags: tagsOf(headers) };
    if (!matches(current, before)) return yield* outOfStep();
    const { language, tags, ...rest } = after;
    yield* db
      .update(song)
      .set({
        ...rest,
        ...(language === undefined ? {} : { language: encodeLanguages(language) }),
        ...(tags === undefined ? {} : { extraHeaders: encodeExtraHeaders(withTags(headers, tags)) }),
      })
      .pipe(orDiskFull);
  });
}

function singerChange(db: Queryable, id: number, before: SingerFields | null, after: SingerFields | null) {
  return Effect.gen(function* () {
    const [row] = yield* db.select().from(singers).where(eq(singers.id, id)).limit(1).pipe(Effect.orDie);
    if (before ? !row || !matches(row, before) : row) return yield* outOfStep();
    if (!after) {
      // A singer is deleted after its lines: deleting it would take them (and their notes) along unseen.
      const [left] = yield* db
        .select({ id: lines.id })
        .from(lines)
        .where(eq(lines.singerId, id))
        .limit(1)
        .pipe(Effect.orDie);
      if (left) return yield* outOfStep();
      yield* db.delete(singers).where(eq(singers.id, id)).pipe(orDiskFull);
    } else if (!before) {
      yield* db
        .insert(singers)
        .values({ id, ...after })
        .pipe(orDiskFull);
    } else {
      yield* db.update(singers).set(after).where(eq(singers.id, id)).pipe(orDiskFull);
    }
  });
}

/** Notes by start within each line, and lines by their first note within each singer; only changed positions are written. */
function putInOrder(db: Queryable) {
  return Effect.gen(function* () {
    const noteRows = yield* db
      .select({ id: notes.id, lineId: notes.lineId, start: notes.start, position: notes.position })
      .from(notes)
      .orderBy(asc(notes.lineId), asc(notes.start), asc(notes.id))
      .pipe(Effect.orDie);
    const firstStart = new Map<number, number>();
    const counters = new Map<number, number>();
    for (const note of noteRows) {
      if (!firstStart.has(note.lineId)) firstStart.set(note.lineId, note.start);
      const position = counters.get(note.lineId) ?? 0;
      counters.set(note.lineId, position + 1);
      if (note.position !== position) {
        yield* db.update(notes).set({ position }).where(eq(notes.id, note.id)).pipe(orDiskFull);
      }
    }
    const lineRows = yield* db
      .select({ id: lines.id, singerId: lines.singerId, position: lines.position })
      .from(lines)
      .pipe(Effect.orDie);
    const ordered = lineRows.toSorted(
      (a, b) =>
        a.singerId - b.singerId ||
        (firstStart.get(a.id) ?? Infinity) - (firstStart.get(b.id) ?? Infinity) ||
        a.id - b.id,
    );
    const lineCounters = new Map<number, number>();
    for (const line of ordered) {
      const position = lineCounters.get(line.singerId) ?? 0;
      lineCounters.set(line.singerId, position + 1);
      if (line.position !== position) {
        yield* db.update(lines).set({ position }).where(eq(lines.id, line.id)).pipe(orDiskFull);
      }
    }
  });
}

/** Applies one edit's changes in order, then puts notes and lines in order. Run it in a transaction. */
export function applyChartChanges(db: Queryable, changes: readonly ChartChange[]) {
  return Effect.gen(function* () {
    for (const change of changes) {
      if (change.table === "note") yield* noteChange(db, change.id, change.before, change.after);
      else if (change.table === "line") yield* lineChange(db, change.id, change.before, change.after);
      else if (change.table === "singer") yield* singerChange(db, change.id, change.before, change.after);
      else yield* songChange(db, change.before, change.after);
    }
    yield* putInOrder(db);
  });
}
