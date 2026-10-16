import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ChartChange } from "../../src/lib/native/contract";
import type { EditorChart } from "../../src/lib/native/types";
import { tempDir } from "../testing";
import type { ProjectChart } from "../ultrastar/chart-mapping";
import { readChart, writeChart } from "./chart";
import { applyChartChanges } from "./chart-changes";
import { createDatabase } from "./database";
import { readEditorChart } from "./editor-chart";
import { migrations } from "./migrations.gen";
import { song } from "./schema";

let cleanup = () => {};
afterEach(() => cleanup());

const note = (start: number, lyric: string) => ({ start, duration: 0.3, pitch: 64, lyric, type: "normal" as const });

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
        { switchStart: 2.5, switchEnd: null, notes: [note(1, "We "), note(1.5, "walk "), note(2, "on")] },
        { switchStart: null, switchEnd: null, notes: [note(3, "to "), note(3.5, "the "), note(4, "sea")] },
      ],
    },
  ],
};

/** A project with the chart, and a way to run edits on it in a transaction like the RPC does. */
function withProject<A, E>(
  run: (db: Parameters<typeof applyChartChanges>[0], before: EditorChart) => Effect.Effect<A, E>,
) {
  const made = tempDir();
  cleanup = made.cleanup;
  return Effect.scoped(
    Effect.gen(function* () {
      const db = yield* createDatabase(
        path.join(made.dir, "Song.tunestudio"),
        "Song.tunestudio",
        "1.0.0",
        "p",
        migrations,
      );
      yield* writeChart(db, chart);
      return yield* run(db, yield* readEditorChart(db));
    }),
  );
}

const fields = (n: EditorChart["singers"][number]["lines"][number]["notes"][number], lineId: number) => ({
  lineId,
  start: n.start,
  duration: n.duration,
  pitch: n.pitch,
  lyric: n.lyric,
  type: n.type,
  edited: n.edited,
});

/** The changes undone: in reverse order, before and after swapped. */
const inverse = (changes: ChartChange[]): ChartChange[] =>
  changes.toReversed().map((change) => ({ ...change, before: change.after, after: change.before }) as ChartChange);

describe("applyChartChanges", () => {
  it.effect("saves, clears and undoes both YouTube source IDs", () =>
    withProject((db, before) =>
      Effect.gen(function* () {
        const edit: ChartChange = {
          table: "song",
          before: { youtubeId: null, youtubeAudioId: null },
          after: { youtubeId: "kPBzTxZQG5Q", youtubeAudioId: "dQw4w9WgXcQ" },
        };
        yield* db.transaction((tx) => applyChartChanges(tx, [edit]));
        expect((yield* readEditorChart(db)).song).toMatchObject(edit.after!);
        expect((yield* readChart(db)).song).toMatchObject(edit.after!);
        yield* db.transaction((tx) => applyChartChanges(tx, inverse([edit])));
        expect(yield* readEditorChart(db)).toEqual(before);
        yield* db.transaction((tx) => applyChartChanges(tx, [edit]));
        yield* db.transaction((tx) =>
          applyChartChanges(tx, [
            {
              table: "song",
              before: { youtubeAudioId: "dQw4w9WgXcQ" },
              after: { youtubeAudioId: null },
            },
          ]),
        );
        expect((yield* readChart(db)).song).toMatchObject({ youtubeId: "kPBzTxZQG5Q", youtubeAudioId: null });
      }),
    ),
  );

  it.effect("moves a note, keeps its line in order, and undoes back to exactly what was there", () =>
    withProject((db, before) =>
      Effect.gen(function* () {
        const line = before.singers[0]!.lines[0]!;
        const walk = line.notes[1]!;
        // "walk" moves after "on": the line's order follows.
        const changes: ChartChange[] = [
          {
            table: "note",
            id: walk.id,
            before: fields(walk, line.id),
            after: { ...fields(walk, line.id), start: 2.5, pitch: 66, edited: true },
          },
        ];
        yield* db.transaction((tx) => applyChartChanges(tx, changes));
        const moved = yield* readEditorChart(db);
        expect(moved.singers[0]!.lines[0]!.notes.map((n) => [n.lyric, n.edited])).toEqual([
          ["We ", false],
          ["on", false],
          ["walk ", true],
        ]);
        yield* db.transaction((tx) => applyChartChanges(tx, inverse(changes)));
        expect(yield* readEditorChart(db)).toEqual(before);
      }),
    ),
  );

  it.effect("splits a line: a new line, and notes moved into it", () =>
    withProject((db, before) =>
      Effect.gen(function* () {
        const [first, second] = before.singers[0]!.lines;
        const on = first!.notes[2]!;
        const newLine = 1000;
        const changes: ChartChange[] = [
          {
            table: "line",
            id: newLine,
            before: null,
            after: { singerId: before.singers[0]!.id, switchStart: null, switchEnd: null },
          },
          { table: "note", id: on.id, before: fields(on, first!.id), after: fields(on, newLine) },
        ];
        yield* db.transaction((tx) => applyChartChanges(tx, changes));
        const split = yield* readEditorChart(db);
        expect(split.singers[0]!.lines.map((l) => l.notes.map((n) => n.lyric).join(""))).toEqual([
          "We walk ",
          "on",
          "to the sea",
        ]);
        expect(split.singers[0]!.lines[1]!.id).toBe(newLine);
        // Undone, the line is gone again and "on" is back.
        yield* db.transaction((tx) => applyChartChanges(tx, inverse(changes)));
        expect(yield* readEditorChart(db)).toEqual(before);
        expect(second).toBeDefined();
      }),
    ),
  );

  it.effect("writes nothing when the editor is out of step with the file", () =>
    withProject((db, before) =>
      Effect.gen(function* () {
        const line = before.singers[0]!.lines[0]!;
        const [we, walk] = line.notes;
        const changes: ChartChange[] = [
          { table: "note", id: we!.id, before: fields(we!, line.id), after: { ...fields(we!, line.id), pitch: 70 } },
          // Expects a pitch the note doesn't have: the whole edit fails, the first change included.
          {
            table: "note",
            id: walk!.id,
            before: { ...fields(walk!, line.id), pitch: 1 },
            after: { ...fields(walk!, line.id), pitch: 2 },
          },
        ];
        const error = yield* Effect.flip(db.transaction((tx) => applyChartChanges(tx, changes)));
        expect(error).toMatchObject({ _tag: "ChartOutOfStep" });
        expect(yield* readEditorChart(db)).toEqual(before);

        // A line still holding notes can't be deleted; a row that exists can't be created again.
        const deleteLine = yield* Effect.flip(
          applyChartChanges(db, [
            {
              table: "line",
              id: line.id,
              before: { singerId: before.singers[0]!.id, switchStart: 2.5, switchEnd: null },
              after: null,
            },
          ]),
        );
        expect(deleteLine._tag).toBe("ChartOutOfStep");
        const createAgain = yield* Effect.flip(
          applyChartChanges(db, [{ table: "note", id: we!.id, before: null, after: fields(we!, line.id) }]),
        );
        expect(createAgain._tag).toBe("ChartOutOfStep");
      }),
    ),
  );

  it.effect("changes song details, checking what they were", () =>
    withProject((db) =>
      Effect.gen(function* () {
        yield* db.transaction((tx) =>
          applyChartChanges(tx, [
            { table: "song", before: { bpm: 300, language: ["English"] }, after: { bpm: 600, language: ["German"] } },
          ]),
        );
        const stored = yield* readChart(db);
        expect(stored.song).toMatchObject({ bpm: 600, language: ["German"], title: "Song" });
        const stale = yield* Effect.flip(
          applyChartChanges(db, [{ table: "song", before: { bpm: 300 }, after: { bpm: 200 } }]),
        );
        expect(stale._tag).toBe("ChartOutOfStep");
      }),
    ),
  );

  it.effect("keeps tags in #TAGS and changes a singer's name, checking what they were", () =>
    withProject((db) =>
      Effect.gen(function* () {
        const chart = yield* readEditorChart(db);
        expect(chart.song.tags).toEqual([]);
        const singer = chart.singers[0]!;
        yield* db.transaction((tx) =>
          applyChartChanges(tx, [
            { table: "song", before: { tags: [] }, after: { tags: ["live", "acoustic"] } },
            { table: "singer", id: singer.id, before: { name: singer.name }, after: { name: "Mia" } },
          ]),
        );
        const after = yield* readEditorChart(db);
        expect(after.song.tags).toEqual(["live", "acoustic"]);
        expect(after.singers[0]!.name).toBe("Mia");
        expect((yield* readChart(db)).song.extraHeaders).toContainEqual(["TAGS", "live, acoustic"]);
        const stale = yield* Effect.flip(
          applyChartChanges(db, [{ table: "singer", id: singer.id, before: { name: null }, after: { name: "Kai" } }]),
        );
        expect(stale._tag).toBe("ChartOutOfStep");
      }),
    ),
  );

  it.effect("reports damaged song details instead of reading them as empty and writing over them", () =>
    withProject((db) =>
      Effect.gen(function* () {
        yield* db.update(song).set({ extraHeaders: "{not json" }).pipe(Effect.orDie);
        expect((yield* Effect.flip(readEditorChart(db)))._tag).toBe("ProjectDamaged");
        const error = yield* Effect.flip(
          applyChartChanges(db, [{ table: "song", before: { tags: [] }, after: { tags: ["live"] } }]),
        );
        expect(error._tag).toBe("ProjectDamaged");
        const [row] = yield* db.select().from(song).pipe(Effect.orDie);
        expect(row!.extraHeaders).toBe("{not json");
      }),
    ),
  );
});
