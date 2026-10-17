import { SqliteClient } from "@effect/sql-sqlite-node";
import { eq, sql } from "drizzle-orm";
import { type EffectSQLiteNodeDatabase, makeWithDefaults } from "drizzle-orm/effect-sqlite-node";
import { Effect, FileSystem, Option, type Scope } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";

import {
  DiskFull,
  type FileError,
  isDiskFull,
  mapFileError,
  NewerProjectVersion,
  NotTuneStudioFile,
  ProjectDamaged,
  quoted,
} from "../errors";
import { migrations } from "./migrations.gen";
import { meta } from "./schema";

/** A `.tunestudio` file's database, as Drizzle sees it. */
export type ProjectDb = EffectSQLiteNodeDatabase;

/** The database inside `db.transaction(...)`. */
export type ProjectTx = Parameters<Parameters<ProjectDb["transaction"]>[0]>[0];

/** Either; queries work the same on both. */
export type Queryable = ProjectDb | ProjectTx;

/** `PRAGMA application_id`: "TSTD" marks a Tune Studio project. */
export const APPLICATION_ID = 0x54535444;

/** The schema version this app writes: one per migration it ships. */
export const FORMAT_VERSION = migrations.length;

/** Migrations to apply, oldest first; tests pass their own to check upgrades. */
export type Migrations = ReadonlyArray<{ readonly name: string; readonly statements: readonly string[] }>;

const SQLITE_MAGIC = "SQLite format 3\u0000";

/**
 * A failing query is a bug, except when the disk is full: that one the user can fix.
 * Use on every write.
 */
export function orDiskFull<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, DiskFull, R> {
  return Effect.catch(effect, (error) =>
    isDiskFull(error)
      ? Effect.fail(new DiskFull({ message: "There isn't enough free disk space to save the project." }))
      : Effect.die(error),
  );
}

/**
 * Checks the file's SQLite header (magic and application ID) without opening it as a
 * database, so a file that isn't a Tune Studio project is never touched.
 */
export function checkHeader(
  path: string,
  name: string,
): Effect.Effect<void, NotTuneStudioFile | FileError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const header = yield* Effect.scoped(
      Effect.flatMap(fs.open(path, { flag: "r" }), (file) => file.readAlloc(100)),
    ).pipe(mapFileError(quoted(name), "open"));
    const bytes = Option.getOrElse(header, () => new Uint8Array());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const isSqlite = bytes.length === 100 && new TextDecoder("latin1").decode(bytes.subarray(0, 16)) === SQLITE_MAGIC;
    if (!isSqlite || view.getUint32(68) !== APPLICATION_ID) {
      return yield* new NotTuneStudioFile({ message: `${quoted(name)} isn't a Tune Studio project.` });
    }
  });
}

/** Opens an SQLite connection on `path` for the current scope (closed with it). */
export function connect(path: string, name: string): Effect.Effect<ProjectDb, ProjectDamaged, Scope.Scope> {
  return Effect.gen(function* () {
    // WAL would put -wal and -shm files next to the project; it stays one file instead.
    const client = yield* SqliteClient.make({ filename: path, disableWAL: true });
    return yield* makeWithDefaults().pipe(Effect.provideService(SqliteClient.SqliteClient, client));
  }).pipe(
    Effect.provide(Reactivity.layer),
    Effect.mapError(() => new ProjectDamaged({ message: `${quoted(name)} couldn't be opened as a project.` })),
  );
}

/** One file, durable writes: a crash mid-write rolls back. Foreign keys keep rows consistent. */
function configure(db: ProjectDb) {
  return Effect.gen(function* () {
    yield* db.run(sql`PRAGMA journal_mode = DELETE`);
    yield* db.run(sql`PRAGMA synchronous = FULL`);
    yield* db.run(sql`PRAGMA foreign_keys = ON`);
  });
}

/** The file's `meta.format_version`. */
function readFormatVersion(db: ProjectDb, name: string): Effect.Effect<number, ProjectDamaged> {
  return db
    .select({ value: meta.value })
    .from(meta)
    .where(eq(meta.key, "format_version"))
    .pipe(
      Effect.mapError(() => new ProjectDamaged({ message: `${quoted(name)} is damaged and can't be read.` })),
      Effect.flatMap((rows) => {
        const version = Number(rows[0]?.value);
        return Number.isSafeInteger(version) && version > 0
          ? Effect.succeed(version)
          : Effect.fail(new ProjectDamaged({ message: `${quoted(name)} is damaged: its format version is missing.` }));
      }),
    );
}

/** `meta` rows to upsert after creating or migrating a file. */
function writeMeta(db: Queryable, values: Record<string, string>) {
  return Effect.forEach(
    Object.entries(values),
    ([key, value]) => db.insert(meta).values({ key, value }).onConflictDoUpdate({ target: meta.key, set: { value } }),
    { discard: true },
  );
}

/**
 * Applies the migrations after `from` in one transaction and records the new version. Foreign keys are off meanwhile:
 * a migration that rebuilds a table (SQLite's way to change a column) drops the old one, which would otherwise delete
 * or empty every row pointing at it (dropping `lines` would take the notes). They are checked before committing.
 */
function migrate(db: ProjectDb, list: Migrations, from: number, extraMeta: Record<string, string>) {
  // `foreign_keys` can't change inside a transaction, so it is switched around it.
  return Effect.andThen(
    db.run(sql`PRAGMA foreign_keys = OFF`),
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          for (const migration of list.slice(from)) {
            for (const statement of migration.statements) yield* tx.run(sql.raw(statement));
          }
          const broken = yield* tx.all(sql`PRAGMA foreign_key_check`);
          if (broken.length > 0) {
            return yield* Effect.fail(new Error(`The migration left ${broken.length} rows pointing at missing rows`));
          }
          yield* writeMeta(tx, { ...extraMeta, format_version: String(list.length) });
        }),
      )
      .pipe(Effect.ensuring(db.run(sql`PRAGMA foreign_keys = ON`).pipe(Effect.orDie))),
  );
}

const now = Effect.sync(() => new Date().toISOString());

/**
 * Opens an existing project: checks it is one, refuses files from a newer Tune Studio (without
 * writing to them) and migrates older ones forward.
 */
export function openDatabase(
  path: string,
  name: string,
  appVersion: string,
  list: Migrations = migrations,
): Effect.Effect<
  ProjectDb,
  NotTuneStudioFile | NewerProjectVersion | ProjectDamaged | FileError,
  Scope.Scope | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* checkHeader(path, name);
    const db = yield* connect(path, name);
    const version = yield* readFormatVersion(db, name);
    if (version > list.length) {
      return yield* new NewerProjectVersion({
        message: `${quoted(name)} was made with a newer Tune Studio. Update Tune Studio to open it.`,
      });
    }
    yield* orDiskFull(configure(db));
    if (version < list.length) {
      const updatedAt = yield* now;
      yield* orDiskFull(migrate(db, list, version, { saved_with: appVersion, updated_at: updatedAt }));
    }
    return db;
  });
}

/** Creates an empty project database at `path`, which must not exist yet. */
export function createDatabase(
  path: string,
  name: string,
  appVersion: string,
  projectId: string,
  list: Migrations = migrations,
): Effect.Effect<ProjectDb, ProjectDamaged | DiskFull, Scope.Scope> {
  return Effect.gen(function* () {
    const db = yield* connect(path, name);
    const createdAt = yield* now;
    yield* orDiskFull(
      Effect.gen(function* () {
        yield* db.run(sql.raw(`PRAGMA application_id = ${APPLICATION_ID}`));
        yield* configure(db);
        yield* migrate(db, list, 0, {
          project_id: projectId,
          created_at: createdAt,
          updated_at: createdAt,
          created_with: appVersion,
          saved_with: appVersion,
        });
      }),
    );
    return db;
  });
}

/** Reads every `meta` row. */
export function readMeta(db: Queryable): Effect.Effect<Record<string, string>> {
  return db
    .select()
    .from(meta)
    .pipe(
      Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.key, row.value]))),
      Effect.orDie,
    );
}

export { writeMeta };
