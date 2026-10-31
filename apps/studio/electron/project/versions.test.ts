import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, type Scope } from "effect";
import { createRoot } from "solid-js";

import { createChartDocument } from "../../src/lib/editor/document";
import { restoreVersion, sameAsVersion } from "../../src/lib/editor/versions";
import type { ChartChange } from "../../src/lib/native/contract";
import type { EditorChart } from "../../src/lib/native/types";
import { tempDir } from "../testing";
import type { ProjectChart } from "../ultrastar/chart-mapping";
import { writeChart } from "./chart";
import { applyChartChanges } from "./chart-changes";
import { createDatabase, type ProjectDb } from "./database";
import { readEditorChart } from "./editor-chart";
import {
  AUTO_EVERY_MS,
  AUTO_KEPT,
  deleteVersion,
  keepVersion,
  LARGE_EDIT,
  LARGE_EDIT_MIN,
  LARGE_EVERY_MS,
  listVersions,
  readVersion,
  renameVersion,
  versionBeforeEdit,
} from "./versions";

let cleanup = () => {};
afterEach(() => cleanup());

const chart: ProjectChart = {
  song: {
    title: "Song",
    artist: "Artist",
    language: ["English"],
    year: null,
    genre: null,
    edition: null,
    creator: null,
    bpm: 300,
    gap: 1,
    videoGap: null,
    start: null,
    end: null,
    previewStart: null,
    medleyStart: null,
    medleyEnd: null,
    extraHeaders: [],
    youtubeId: null,
    youtubeAudioId: null,
  },
  singers: [
    {
      index: 1,
      name: null,
      lines: [
        {
          switchStart: null,
          switchEnd: null,
          notes: [
            { start: 1, duration: 0.3, pitch: 64, lyric: "We ", type: "normal" },
            { start: 1.5, duration: 0.3, pitch: 65, lyric: "walk", type: "normal" },
          ],
        },
      ],
    },
  ],
};

/** The chart with `count` notes in its line. */
function withNotes(count: number): ProjectChart {
  const [singer] = chart.singers;
  const notes = Array.from({ length: count }, (_, index) => ({
    start: 1 + index,
    duration: 0.3,
    pitch: 64,
    lyric: `la${index} `,
    type: "normal" as const,
  }));
  return { ...chart, singers: [{ ...singer!, lines: [{ ...singer!.lines[0]!, notes }] }] };
}

function withProject<A, E>(run: (db: ProjectDb) => Effect.Effect<A, E, Scope.Scope>, written = chart) {
  const made = tempDir();
  cleanup = made.cleanup;
  return Effect.scoped(
    Effect.gen(function* () {
      const db = yield* createDatabase(path.join(made.dir, "Song.tunestudio"), "Song.tunestudio", "1.0.0", "p");
      yield* writeChart(db, written);
      return yield* run(db);
    }),
  );
}

/** An edit renaming the first note's syllable, with what the editor would send. */
function rename(current: EditorChart, lyric: string): ChartChange[] {
  const line = current.singers[0]!.lines[0]!;
  const { id, ...note } = line.notes[0]!;
  return [
    {
      table: "note",
      id,
      before: { ...note, lineId: line.id },
      after: { ...note, lineId: line.id, lyric, edited: true },
    },
  ];
}

/** Runs an edit the way `project.applyChanges` does: a version first when one is due. */
function applyEdit(
  db: ProjectDb,
  session: object,
  changes: ChartChange[],
  at: Date,
  edit: { label?: string; rows?: number; keep?: boolean } = {},
) {
  return db
    .transaction((tx) =>
      Effect.gen(function* () {
        const remember = yield* versionBeforeEdit(
          tx,
          session,
          { label: edit.label, rows: edit.rows ?? changes.length, keep: edit.keep },
          at,
        );
        yield* applyChartChanges(tx, changes);
        return remember;
      }),
    )
    .pipe(Effect.map((remember) => remember()));
}

const firstLyric = (version: EditorChart) => version.singers[0]!.lines[0]!.notes[0]!.lyric;

describe("versions", () => {
  it.effect("keeps one before a session's first edit, then not again until half an hour has passed", () =>
    withProject((db) =>
      Effect.gen(function* () {
        const session = {};
        const start = new Date("2026-10-28T10:00:00Z");
        yield* applyEdit(db, session, rename(yield* readEditorChart(db), "One "), start);
        yield* applyEdit(db, session, rename(yield* readEditorChart(db), "Two "), new Date(start.getTime() + 60_000));
        const first = yield* listVersions(db);
        expect(first.map((version) => version.label)).toEqual(["Before editing"]);
        expect(first[0]).toMatchObject({ kind: "auto", notes: 2, lines: 1 });
        expect(firstLyric(yield* readVersion(db, first[0]!.id))).toBe("We ");

        yield* applyEdit(
          db,
          session,
          rename(yield* readEditorChart(db), "Three "),
          new Date(start.getTime() + AUTO_EVERY_MS + 60_000),
        );
        const versions = yield* listVersions(db);
        expect(versions.map((version) => version.label)).toEqual(["While editing", "Before editing"]);
        expect(firstLyric(yield* readVersion(db, versions[0]!.id))).toBe("Two ");
      }),
    ),
  );

  it.effect("doesn't count a version whose edit was rolled back", () =>
    withProject((db) =>
      Effect.gen(function* () {
        const session = {};
        const at = new Date("2026-10-28T10:00:00Z");
        const current = yield* readEditorChart(db);
        // An edit made against a chart the file no longer has: refused, and its version goes with it.
        const stale = rename(current, "One ").map((change) =>
          change.table === "note" ? { ...change, before: { ...change.before!, lyric: "Gone " } } : change,
        );
        const refused = yield* Effect.flip(applyEdit(db, session, stale, at));
        expect(refused._tag).toBe("ChartOutOfStep");
        expect(yield* listVersions(db)).toEqual([]);
        yield* applyEdit(db, session, rename(current, "Two "), at);
        expect((yield* listVersions(db)).map((version) => version.label)).toEqual(["Before editing"]);
      }),
    ),
  );

  it.effect("keeps one before a large edit, or one that asks, named after it", () =>
    withProject((db) =>
      Effect.gen(function* () {
        const session = {};
        const at = new Date("2026-10-28T10:00:00Z");
        const later = new Date(at.getTime() + LARGE_EVERY_MS);
        yield* applyEdit(db, session, rename(yield* readEditorChart(db), "One "), at);
        yield* applyEdit(db, session, rename(yield* readEditorChart(db), "Two "), later, {
          label: "Auto pitch",
          rows: LARGE_EDIT,
        });
        // Asked for: kept however soon after the last.
        yield* applyEdit(db, session, rename(yield* readEditorChart(db), "Three "), later, {
          label: "Restore version",
          keep: true,
        });
        const versions = yield* listVersions(db);
        expect(versions.map((version) => version.label)).toEqual([
          "Before Restore version",
          "Before Auto pitch",
          "Before editing",
        ]);
        expect(firstLyric(yield* readVersion(db, versions[0]!.id))).toBe("Two ");
        expect(firstLyric(yield* readVersion(db, versions[1]!.id))).toBe("One ");
      }),
    ),
  );

  it.effect("keeps one before a run of the same large edit, and not before one right after another large one", () =>
    withProject((db) =>
      Effect.gen(function* () {
        const session = {};
        const start = new Date("2026-10-28T10:00:00Z").getTime();
        const large = (lyric: string, label: string, ms: number) =>
          Effect.flatMap(readEditorChart(db), (current) =>
            applyEdit(db, session, rename(current, lyric), new Date(start + ms), { label, rows: LARGE_EDIT }),
          );
        // Every note moved, one arrow press at a time, even minutes apart: one version.
        for (let press = 0; press < 5; press++)
          yield* large(`Move ${press} `, "Move 212 notes", press * LARGE_EVERY_MS);
        // Another large edit right after the last one: none.
        yield* large("Pitch ", "Change pitch of 212 notes", 4 * LARGE_EVERY_MS + 1000);
        // A minute after that: one.
        yield* large("Auto ", "Auto pitch 212 notes", 5 * LARGE_EVERY_MS + 1000);
        // Fixed by hand, then the same again: one, since it doesn't repeat the edit just before it.
        yield* applyEdit(
          db,
          session,
          rename(yield* readEditorChart(db), "Fixed "),
          new Date(start + 7 * LARGE_EVERY_MS),
        );
        yield* large("Again ", "Auto pitch 212 notes", 8 * LARGE_EVERY_MS);
        expect((yield* listVersions(db)).map((version) => version.label)).toEqual([
          "Before Auto pitch 212 notes",
          "Before Auto pitch 212 notes",
          "Before Move 212 notes",
        ]);
      }),
    ),
  );

  it.effect.each([
    { notes: 100, small: 19, large: 20 },
    { notes: 12, small: LARGE_EDIT_MIN - 1, large: LARGE_EDIT_MIN },
  ])("counts an edit of a fifth of a $notes-note chart as large, from a few rows", ({ notes, small, large }) =>
    withProject(
      (db) =>
        Effect.gen(function* () {
          const session = {};
          const start = new Date("2026-10-28T10:00:00Z").getTime();
          const edit = (lyric: string, rows: number, ms: number) =>
            Effect.flatMap(readEditorChart(db), (current) =>
              applyEdit(db, session, rename(current, lyric), new Date(start + ms), { label: `Edit ${rows}`, rows }),
            );
          yield* edit("One ", 1, 0);
          yield* edit("Two ", small, LARGE_EVERY_MS);
          yield* edit("Three ", large, 2 * LARGE_EVERY_MS);
          expect((yield* listVersions(db)).map((version) => version.label)).toEqual([
            `Before Edit ${large}`,
            "Before editing",
          ]);
        }),
      withNotes(notes),
    ),
  );

  it.effect("doesn't keep an automatic version the same as the newest one", () =>
    withProject((db) =>
      Effect.gen(function* () {
        const at = new Date("2026-10-28T10:00:00Z");
        yield* applyEdit(db, {}, rename(yield* readEditorChart(db), "One "), at);
        // Opened again: the chart is as the last session left it, which the first version doesn't have.
        yield* applyEdit(db, {}, rename(yield* readEditorChart(db), "Two "), at);
        // And again, with a version of exactly this chart already the newest.
        yield* keepVersion(db, "Mine", "named", at);
        yield* applyEdit(db, {}, rename(yield* readEditorChart(db), "Three "), at);
        expect((yield* listVersions(db)).map((version) => version.label)).toEqual([
          "Mine",
          "Before editing",
          "Before editing",
        ]);
      }),
    ),
  );

  it.effect("prunes automatic versions to the latest few and keeps named ones", () =>
    withProject((db) =>
      Effect.gen(function* () {
        const start = Date.parse("2026-10-28T10:00:00Z");
        yield* keepVersion(db, "Mine", "named", new Date(start));
        for (let index = 1; index <= AUTO_KEPT + 3; index++) {
          // Each one different, or it wouldn't be stored.
          yield* applyChartChanges(db, rename(yield* readEditorChart(db), `Take ${index} `));
          yield* keepVersion(db, `Auto ${index}`, "auto", new Date(start + index * 1000));
        }
        const versions = yield* listVersions(db);
        expect(versions).toHaveLength(AUTO_KEPT + 1);
        expect(versions[0]!.label).toBe(`Auto ${AUTO_KEPT + 3}`);
        expect(versions.at(-2)!.label).toBe("Auto 4");
        expect(versions.at(-1)!.label).toBe("Mine");
      }),
    ),
  );

  it.effect("thins older automatic versions to one a day for a week, then one a week for a month", () =>
    withProject((db) =>
      Effect.gen(function* () {
        // Days are the computer's: in Berlin's summer time a day ends at 22:00 UTC.
        const zone = process.env.TZ;
        process.env.TZ = "Europe/Berlin";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (zone === undefined) delete process.env.TZ;
            else process.env.TZ = zone;
          }),
        );
        const hour = 60 * 60_000;
        const day = 24 * hour;
        const start = Date.parse("2026-09-01T10:00:00Z");
        yield* keepVersion(db, "Mine", "named", new Date(start));
        // Every 6 hours for 40 days.
        const end = start + 40 * day;
        for (let at = start + 6 * hour, take = 1; at <= end; at += 6 * hour, take++) {
          yield* applyChartChanges(db, rename(yield* readEditorChart(db), `Take ${take} `));
          yield* keepVersion(db, `Auto ${take}`, "auto", new Date(at));
        }
        const versions = yield* listVersions(db);
        const auto = versions
          .filter((version) => version.kind === "auto")
          .map((version) => version.createdAt.slice(0, 16));
        expect(auto).toEqual([
          // The last day: all of them.
          "2026-10-11T10:00",
          "2026-10-11T04:00",
          "2026-10-10T22:00",
          "2026-10-10T16:00",
          // The week before: each day's newest, 18:00 in Berlin (22:00 UTC is already the next day there).
          "2026-10-10T10:00",
          "2026-10-09T16:00",
          "2026-10-08T16:00",
          "2026-10-07T16:00",
          "2026-10-06T16:00",
          "2026-10-05T16:00",
          "2026-10-04T16:00",
          // Until four weeks back: each week's newest (Monday to Sunday); nothing older.
          "2026-10-03T16:00",
          "2026-09-27T16:00",
          "2026-09-20T16:00",
          "2026-09-13T16:00",
        ]);
        expect(versions.at(-1)!.label).toBe("Mine");
      }),
    ),
  );

  it.effect("restores a solo version over a duet and back, as the project saves the editor's changes", () =>
    Effect.gen(function* () {
      const made = tempDir();
      cleanup = made.cleanup;
      const open = (name: string, written: ProjectChart) =>
        Effect.tap(createDatabase(path.join(made.dir, name), name, "1.0.0", name), (db) => writeChart(db, written));
      const solo = yield* readEditorChart(yield* open("Solo.tunestudio", chart));
      const db = yield* open("Duet.tunestudio", {
        ...chart,
        singers: [
          { ...chart.singers[0]!, name: "Anna" },
          {
            index: 2,
            name: "Ben",
            lines: [
              {
                switchStart: null,
                switchEnd: null,
                notes: [{ start: 4, duration: 0.5, pitch: 60, lyric: "Hey", type: "golden" }],
              },
            ],
          },
        ],
      });
      const duet = yield* readEditorChart(db);
      /** Restores `version` in an editor on the project's chart, saving its changes the way the project does. */
      const restore = (version: EditorChart) =>
        Effect.gen(function* () {
          const saved: ChartChange[][] = [];
          const current = yield* readEditorChart(db);
          const doc = createRoot(() =>
            createChartDocument<number[]>({
              chart: current,
              save: async (changes) => void saved.push(changes),
              onFailed: () => {},
              selection: () => [],
              setSelection: () => {},
            }),
          );
          doc.edit("Restore version", (tx) => restoreVersion(tx, doc.chart(), version), { keepVersion: true });
          yield* Effect.promise(() => doc.saved());
          for (const changes of saved) yield* db.transaction((tx) => applyChartChanges(tx, changes));
          return yield* readEditorChart(db);
        });
      expect(sameAsVersion(duet, solo)).toBe(false);
      expect(sameAsVersion(yield* restore(solo), solo)).toBe(true);
      expect(sameAsVersion(yield* restore(duet), duet)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("names, deletes and reports a version that is gone", () =>
    withProject((db) =>
      Effect.gen(function* () {
        const kept = (yield* keepVersion(db, "Before editing", "auto"))!;
        yield* renameVersion(db, kept.id, "First draft");
        expect(yield* listVersions(db)).toMatchObject([{ label: "First draft", kind: "named" }]);
        yield* deleteVersion(db, kept.id);
        expect(yield* listVersions(db)).toEqual([]);
        const missing = yield* Effect.flip(readVersion(db, kept.id));
        expect(missing._tag).toBe("VersionUnavailable");
        expect((yield* Effect.flip(renameVersion(db, kept.id, "Again")))._tag).toBe("VersionUnavailable");
      }),
    ),
  );
});
