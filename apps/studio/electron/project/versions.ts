/**
 * Versions: earlier states of the chart kept in the project file, to go back to when something went wrong after undo
 * could help (the undo history lasts a session). Like Logic's and Ableton's backups they hold only the chart, not the
 * media, and live in the project, so they are no backup of the file itself.
 *
 * One is taken automatically before the first edit of a session, before a large edit, and every half hour of editing;
 * the user saves and names others. Automatic ones are thinned the way Time Machine thins backups (`prune`); named ones
 * stay until deleted.
 */
import { gunzipSync, gzipSync } from "node:zlib";

import { count, desc, eq, inArray } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { EditorChart } from "../../src/lib/native/types";
import { VersionUnavailable } from "../errors";
import { orDiskFull, type Queryable } from "./database";
import { readEditorChart } from "./editor-chart";
import { notes, versions } from "./schema";

/** How many automatic versions from the last day are kept. */
export const AUTO_KEPT = 30;
const DAY_MS = 24 * 60 * 60_000;
/** Before the last day, one automatic version a day for this many days, then one a week until `AUTO_KEPT_DAYS`. */
const DAILY_DAYS = 7;
const AUTO_KEPT_DAYS = 28;
/** While editing, an automatic version at most this often (ms). */
export const AUTO_EVERY_MS = 30 * 60_000;
/** An edit of this many rows or more (auto pitch, chart range, a paste, a gap change) gets a version before it. */
export const LARGE_EDIT = 50;
/** So does one touching this share of the chart's notes, from `LARGE_EDIT_MIN` rows: a short chart may not have 50. */
export const LARGE_SHARE = 0.2;
export const LARGE_EDIT_MIN = 10;
/** A large edit within this long of the previous large edit doesn't get a version (ms). */
export const LARGE_EVERY_MS = 60_000;

const ChartJson = Schema.fromJsonString(EditorChart);
const encodeChart = Schema.encodeSync(ChartJson);
const decodeChart = Schema.decodeUnknownEffect(ChartJson);

const listed = {
  id: versions.id,
  createdAt: versions.createdAt,
  label: versions.label,
  kind: versions.kind,
  notes: versions.notes,
  lines: versions.lines,
};

const gone = () => new VersionUnavailable({ message: "That version isn't in the project anymore." });

/** The chart's versions, newest first. */
export function listVersions(db: Queryable) {
  return db.select(listed).from(versions).orderBy(desc(versions.createdAt), desc(versions.id)).pipe(Effect.orDie);
}

/**
 * Keeps the chart as `db` has it now. An automatic version the same as the newest one isn't stored again (opening and
 * editing a project without changing anything in between). Returns the version, or null when it wasn't stored.
 */
export function keepVersion(db: Queryable, label: string, kind: "auto" | "named", at = new Date()) {
  return Effect.gen(function* () {
    const chart = yield* readEditorChart(db);
    const data = gzipSync(encodeChart(chart));
    if (kind === "auto") {
      const [newest] = yield* db
        .select({ data: versions.data })
        .from(versions)
        .orderBy(desc(versions.createdAt), desc(versions.id))
        .limit(1)
        .pipe(Effect.orDie);
      if (newest?.data.equals(data)) return null;
    }
    const lines = chart.singers.flatMap((singer) => singer.lines);
    const [row] = yield* db
      .insert(versions)
      .values({
        createdAt: at.toISOString(),
        label,
        kind,
        notes: lines.reduce((count, line) => count + line.notes.length, 0),
        lines: lines.length,
        data,
      })
      .returning(listed)
      .pipe(orDiskFull);
    if (kind === "auto") yield* prune(db, at);
    return row!;
  });
}

/** Which local calendar day `at` is in, counted from 1 January 1970 (a Thursday). */
function localDay(at: number) {
  const date = new Date(at);
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/**
 * Thins the automatic versions as of `now`: the newest `AUTO_KEPT` of the last day, the newest of each day before that
 * for a week, the newest of each week until `AUTO_KEPT_DAYS`, nothing older. So the list reaches back weeks while
 * staying around 40 versions. Days and weeks are the calendar's (the computer's time zone, weeks from Monday), not
 * counted back from `now`: counted back, they would move with every new version and only the newest of each would
 * ever survive.
 */
function prune(db: Queryable, now: Date) {
  return Effect.gen(function* () {
    const auto = yield* db
      .select({ id: versions.id, createdAt: versions.createdAt })
      .from(versions)
      .where(eq(versions.kind, "auto"))
      .orderBy(desc(versions.createdAt), desc(versions.id))
      .pipe(Effect.orDie);
    const buckets = new Set<string>();
    let recent = 0;
    const gone: number[] = [];
    // Newest first, so the first version met in a day or week is its newest.
    for (const version of auto) {
      const at = Date.parse(version.createdAt);
      const age = (now.getTime() - at) / DAY_MS;
      if (age < 1) {
        if (recent++ >= AUTO_KEPT) gone.push(version.id);
        continue;
      }
      const day = localDay(at);
      const bucket =
        age < DAILY_DAYS ? `day ${day}` : age < AUTO_KEPT_DAYS ? `week ${Math.floor((day + 3) / 7)}` : null;
      if (bucket === null || buckets.has(bucket)) gone.push(version.id);
      else buckets.add(bucket);
    }
    if (gone.length > 0) yield* db.delete(versions).where(inArray(versions.id, gone)).pipe(orDiskFull);
  });
}

/** A version's chart. */
export function readVersion(db: Queryable, id: number) {
  return Effect.gen(function* () {
    const [row] = yield* db
      .select({ data: versions.data })
      .from(versions)
      .where(eq(versions.id, id))
      .limit(1)
      .pipe(Effect.orDie);
    if (!row) return yield* gone();
    const json = yield* Effect.try({
      try: () => gunzipSync(row.data).toString("utf8"),
      catch: () => new VersionUnavailable({ message: "That version is damaged and can't be restored." }),
    });
    return yield* decodeChart(json).pipe(
      Effect.mapError(() => new VersionUnavailable({ message: "That version is damaged and can't be restored." })),
    );
  });
}

/** Names a version; a named version stays until deleted. */
export function renameVersion(db: Queryable, id: number, name: string) {
  return Effect.gen(function* () {
    const renamed = yield* db
      .update(versions)
      .set({ label: name, kind: "named" })
      .where(eq(versions.id, id))
      .returning({ id: versions.id })
      .pipe(orDiskFull);
    if (renamed.length === 0) return yield* gone();
  });
}

/** Deletes a version, named or not; one already gone is no error. */
export function deleteVersion(db: Queryable, id: number) {
  return Effect.asVoid(db.delete(versions).where(eq(versions.id, id)).pipe(orDiskFull));
}

function noteCount(db: Queryable) {
  return db
    .select({ notes: count() })
    .from(notes)
    .pipe(
      Effect.map(([row]) => row?.notes ?? 0),
      Effect.orDie,
    );
}

/**
 * Per open project (by its session): when it last got an automatic version, when its last large edit was, and the
 * label of its last edit.
 */
const sessions = new WeakMap<object, { at: number; largeAt: number; label: string | undefined }>();

/**
 * Keeps an automatic version before an edit when it is due: the session's first edit, a large edit (or one that asks
 * for it, `keep`), or half an hour after the last. Large is `LARGE_EDIT` rows, or a fifth of the chart's notes from
 * `LARGE_EDIT_MIN`. A large edit repeating the one just before it, or within a minute of the last large one, doesn't
 * get another: moving every note, one arrow press at a time, keeps one version, not one a press. Running Auto pitch
 * again after fixing notes by hand does.
 *
 * Run it in the edit's transaction, before its changes, and call what it returns once the transaction committed: a
 * rolled-back edit takes its version with it, so the session mustn't count it.
 */
export function versionBeforeEdit(
  db: Queryable,
  session: object,
  edit: { readonly label?: string; readonly rows: number; readonly keep?: boolean },
  now = new Date(),
) {
  return Effect.gen(function* () {
    const last = sessions.get(session);
    const at = now.getTime();
    const isLarge =
      edit.rows >= LARGE_EDIT || (edit.rows >= LARGE_EDIT_MIN && edit.rows >= LARGE_SHARE * (yield* noteCount(db)));
    const large =
      edit.keep === true ||
      (isLarge && (last === undefined || (edit.label !== last.label && at - last.largeAt >= LARGE_EVERY_MS)));
    const label = large
      ? `Before ${edit.label ?? "a large edit"}`
      : last === undefined
        ? "Before editing"
        : at - last.at >= AUTO_EVERY_MS
          ? "While editing"
          : null;
    if (label !== null) yield* keepVersion(db, label, "auto", now);
    const largeAt = isLarge ? at : (last?.largeAt ?? -Infinity);
    return () => {
      sessions.set(session, { at: label === null ? last!.at : at, largeAt, label: edit.label });
    };
  });
}
