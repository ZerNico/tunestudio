import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { migrationsModule, migrationsDir } from "../../scripts/bundle-migrations";
import { FileNotFound, NewerProjectVersion, NotTuneStudioFile, ProjectDamaged } from "../errors";
import { tempDir } from "../testing";
import { APPLICATION_ID, createDatabase, FORMAT_VERSION, openDatabase, readMeta } from "./database";
import { migrations } from "./migrations.gen";
import { meta, song } from "./schema";

let cleanup = () => {};

/** The messages of an error and its causes, which is where SQLite's own message ends up. */
function causes(error: unknown): string {
  return error instanceof Error ? `${error.message} ${causes(error.cause)}` : String(error ?? "");
}
afterEach(() => cleanup());

function temp() {
  const made = tempDir();
  cleanup = made.cleanup;
  return made.dir;
}

const create = (file: string, list = migrations) =>
  Effect.runPromise(
    Effect.scoped(createDatabase(file, path.basename(file), "1.0.0", "project-1", list)).pipe(Effect.asVoid),
  );

const open = (file: string, list = migrations) =>
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* openDatabase(file, path.basename(file), "2.0.0", list);
      return yield* readMeta(db);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("project database", () => {
  it("creates a single-file project marked as Tune Studio, with every table and the meta rows", async () => {
    const file = path.join(temp(), "Song.tunestudio");
    await create(file);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["Song.tunestudio"]);

    const raw = new DatabaseSync(file, { readOnly: true });
    expect(raw.prepare("PRAGMA application_id").get()).toEqual({ application_id: APPLICATION_ID });
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      "analysis",
      "editor_state",
      "lines",
      "media",
      "media_chunks",
      "meta",
      "notes",
      "singers",
      "song",
    ]);
    raw.close();

    const values = await Effect.runPromise(open(file));
    expect(values).toMatchObject({
      format_version: String(FORMAT_VERSION),
      project_id: "project-1",
      created_with: "1.0.0",
      saved_with: "1.0.0",
    });
    expect(Date.parse(values.created_at!)).not.toBeNaN();
  });

  it("migrates an older project forward in one go and records the app that did it", async () => {
    const file = path.join(temp(), "Old.tunestudio");
    await create(file);
    const newer = [...migrations, { name: "test_add_rating", statements: ["ALTER TABLE `song` ADD `rating` integer"] }];
    const values = await Effect.runPromise(open(file, newer));
    expect(values.format_version).toBe(String(FORMAT_VERSION + 1));
    expect(values.saved_with).toBe("2.0.0");
    expect(values.created_with).toBe("1.0.0");
    const raw = new DatabaseSync(file, { readOnly: true });
    expect(raw.prepare("SELECT name FROM pragma_table_info('song') WHERE name = 'rating'").get()).toEqual({
      name: "rating",
    });
    raw.close();
  });

  it("rolls a failing migration back completely", async () => {
    const file = path.join(temp(), "Broken.tunestudio");
    await create(file);
    const broken = [
      ...migrations,
      { name: "test_broken", statements: ["ALTER TABLE `song` ADD `rating` integer", "THIS IS NOT SQL"] },
    ];
    await expect(Effect.runPromise(open(file, broken))).rejects.toBeDefined();
    const values = await Effect.runPromise(open(file));
    expect(values.format_version).toBe(String(FORMAT_VERSION));
    const raw = new DatabaseSync(file, { readOnly: true });
    expect(raw.prepare("SELECT name FROM pragma_table_info('song') WHERE name = 'rating'").get()).toBeUndefined();
    raw.close();
  });

  it("keeps the rows pointing at a table a migration rebuilds", async () => {
    const file = path.join(temp(), "Rebuilt.tunestudio");
    await create(file);
    const raw = new DatabaseSync(file);
    raw.exec(`INSERT INTO singers (id, "index") VALUES (1, 0);
      INSERT INTO lines (id, singer_id, position) VALUES (1, 1, 0);
      INSERT INTO notes (line_id, position, start, duration, pitch, lyric, type) VALUES (1, 0, 1, 0.5, 60, 'La', 'normal')`);
    raw.close();
    // SQLite's way to change a column: a new table, the rows copied over, the old one dropped and the new one renamed.
    const rebuild = {
      name: "test_rebuild_lines",
      statements: [
        "CREATE TABLE `lines_new` (`id` integer PRIMARY KEY, `singer_id` integer NOT NULL, `position` integer NOT NULL, `switch_start` real, `switch_end` real, `label` text, CONSTRAINT `fk_lines_singer_id_singers_id_fk` FOREIGN KEY (`singer_id`) REFERENCES `singers`(`id`) ON DELETE CASCADE)",
        "INSERT INTO `lines_new` (`id`, `singer_id`, `position`, `switch_start`, `switch_end`) SELECT `id`, `singer_id`, `position`, `switch_start`, `switch_end` FROM `lines`",
        "DROP TABLE `lines`",
        "ALTER TABLE `lines_new` RENAME TO `lines`",
      ],
    };
    const values = await Effect.runPromise(open(file, [...migrations, rebuild]));
    expect(values.format_version).toBe(String(FORMAT_VERSION + 1));
    const check = new DatabaseSync(file, { readOnly: true });
    expect(check.prepare("SELECT lyric FROM notes").all()).toEqual([{ lyric: "La" }]);
    check.close();
  });

  it("rolls a migration back that leaves rows pointing at missing ones", async () => {
    const file = path.join(temp(), "Dangling.tunestudio");
    await create(file);
    const raw = new DatabaseSync(file);
    raw.exec(
      `INSERT INTO singers (id, "index") VALUES (1, 0); INSERT INTO lines (id, singer_id, position) VALUES (1, 1, 0)`,
    );
    raw.close();
    const dangling = [...migrations, { name: "test_dangling", statements: ["DELETE FROM `singers`"] }];
    await expect(Effect.runPromise(open(file, dangling))).rejects.toBeDefined();
    const check = new DatabaseSync(file, { readOnly: true });
    expect(check.prepare("SELECT count(*) AS count FROM singers").get()).toEqual({ count: 1 });
    check.close();
    // Foreign keys are on again afterwards.
    const values = await Effect.runPromise(open(file));
    expect(values.format_version).toBe(String(FORMAT_VERSION));
  });

  it("refuses a project from a newer Tune Studio without writing to it", async () => {
    const file = path.join(temp(), "Future.tunestudio");
    await create(file, [...migrations, { name: "future", statements: ["CREATE TABLE `future` (`id` integer)"] }]);
    const before = fs.readFileSync(file);
    const error = await Effect.runPromise(Effect.flip(open(file)));
    expect(error).toBeInstanceOf(NewerProjectVersion);
    expect(error.message).toBe("“Future.tunestudio” was made with a newer Tune Studio. Update Tune Studio to open it.");
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("refuses SQLite files that aren't projects, and other files, without touching them", async () => {
    const dir = temp();
    const other = path.join(dir, "notes.sqlite");
    const raw = new DatabaseSync(other);
    raw.exec("PRAGMA journal_mode = WAL; CREATE TABLE notes (id INTEGER)");
    raw.close();
    const text = path.join(dir, "song.tunestudio");
    fs.writeFileSync(text, "#TITLE:Not a database\n");
    const empty = path.join(dir, "empty.tunestudio");
    fs.writeFileSync(empty, "");

    for (const file of [other, text, empty]) {
      const before = fs.readFileSync(file);
      const error = await Effect.runPromise(Effect.flip(open(file)));
      expect(error).toBeInstanceOf(NotTuneStudioFile);
      expect(error.message).toBe(`“${path.basename(file)}” isn't a Tune Studio project.`);
      expect(fs.readFileSync(file).equals(before)).toBe(true);
    }
    expect(fs.readdirSync(dir).toSorted()).toEqual(["empty.tunestudio", "notes.sqlite", "song.tunestudio"]);
  });

  it("reports a missing file as such", async () => {
    const error = await Effect.runPromise(Effect.flip(open(path.join(temp(), "Gone.tunestudio"))));
    expect(error).toBeInstanceOf(FileNotFound);
  });

  it("reports a damaged project whose meta table is gone", async () => {
    const file = path.join(temp(), "Damaged.tunestudio");
    await create(file);
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE meta");
    raw.close();
    const error = await Effect.runPromise(Effect.flip(open(file)));
    expect(error).toBeInstanceOf(ProjectDamaged);
  });

  it("keeps rows written through Drizzle, with foreign keys enforced", async () => {
    const file = path.join(temp(), "Rows.tunestudio");
    await create(file);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const db = yield* openDatabase(file, "Rows.tunestudio", "1.0.0");
          yield* db.insert(song).values({ id: 1, title: "T", artist: "A", bpm: 300 });
          const rows = yield* db.select().from(song);
          const orphan = yield* Effect.flip(db.run(sql`INSERT INTO lines (singer_id, position) VALUES (99, 0)`));
          const metaRow = yield* db.select().from(meta).where(eq(meta.key, "format_version"));
          return { rows, orphan, metaRow };
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(result.rows).toEqual([expect.objectContaining({ title: "T", artist: "A", bpm: 300, language: "[]" })]);
    expect(causes(result.orphan)).toMatch(/FOREIGN KEY/i);
    expect(result.metaRow).toEqual([{ key: "format_version", value: String(FORMAT_VERSION) }]);
  });

  it("bundles exactly the migrations drizzle-kit generated", () => {
    const generated = fs.readFileSync(path.join(import.meta.dirname, "migrations.gen.ts"), "utf8");
    expect(generated).toBe(migrationsModule(migrationsDir));
  });
});
