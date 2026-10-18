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

  it.effect("checks each change against the ones before it in the same edit", () =>
    withProject((db, before) =>
      Effect.gen(function* () {
        const line = before.singers[0]!.lines[0]!;
        const walk = fields(line.notes[1]!, line.id);
        const added = { ...walk, start: 2.6, lyric: "far", edited: true };
        const changes: ChartChange[] = [
          { table: "note", id: 500, before: null, after: added },
          { table: "note", id: 500, before: added, after: { ...added, pitch: 70 } },
          { table: "note", id: line.notes[1]!.id, before: walk, after: { ...walk, pitch: 61 } },
          { table: "note", id: line.notes[1]!.id, before: { ...walk, pitch: 61 }, after: null },
        ];
        yield* db.transaction((tx) => applyChartChanges(tx, changes));
        const changed = yield* readEditorChart(db);
        expect(changed.singers[0]!.lines[0]!.notes.map((n) => [n.id, n.lyric, n.pitch, n.edited])).toEqual([
          [line.notes[0]!.id, "We ", 64, false],
          [line.notes[2]!.id, "on", 64, false],
          [500, "far", 70, true],
        ]);
        yield* db.transaction((tx) => applyChartChanges(tx, inverse(changes)));
        expect(yield* readEditorChart(db)).toEqual(before);

        // A second change expecting what the first one replaced is out of step.
        const stale = yield* Effect.flip(
          db.transaction((tx) =>
            applyChartChanges(tx, [
              { table: "note", id: line.notes[1]!.id, before: walk, after: { ...walk, pitch: 61 } },
              { table: "note", id: line.notes[1]!.id, before: walk, after: { ...walk, pitch: 62 } },
            ]),
          ),
        );
        expect(stale._tag).toBe("ChartOutOfStep");
        // A note deleted earlier in the edit can't be changed, and can be created again.
        const deleted = yield* Effect.flip(
          db.transaction((tx) =>
            applyChartChanges(tx, [
              { table: "note", id: line.notes[1]!.id, before: walk, after: null },
              { table: "note", id: line.notes[1]!.id, before: walk, after: walk },
            ]),
          ),
        );
        expect(deleted._tag).toBe("ChartOutOfStep");
        yield* db.transaction((tx) =>
          applyChartChanges(tx, [
            { table: "note", id: line.notes[1]!.id, before: walk, after: null },
            { table: "note", id: line.notes[1]!.id, before: null, after: walk },
          ]),
        );
        expect(yield* readEditorChart(db)).toEqual(before);
      }),
    ),
  );

  it.effect("applies an edit of more notes than one read takes, in order", () =>
    withProject((db, before) =>
      Effect.gen(function* () {
        const line = before.singers[0]!.lines[1]!;
        const added: ChartChange[] = Array.from({ length: 1200 }, (_, index) => ({
          table: "note",
          id: 2000 + index,
          before: null,
          after: {
            lineId: line.id,
            start: 5 + (1200 - index) * 0.01,
            duration: 0.01,
            pitch: 60,
            lyric: "a",
            type: "normal",
            edited: false,
          },
        }));
        yield* db.transaction((tx) => applyChartChanges(tx, added));
        const moved = added.map((change) => ({
          ...change,
          before: change.after,
          after: { ...change.after!, pitch: 62, edited: true },
        })) as ChartChange[];
        // The last one is stale: nothing of the edit is written.
        const last = moved.at(-1)!;
        const stale = [...moved.slice(0, -1), { ...last, before: { ...last.before!, pitch: 1 } } as ChartChange];
        expect((yield* Effect.flip(db.transaction((tx) => applyChartChanges(tx, stale))))._tag).toBe("ChartOutOfStep");
        yield* db.transaction((tx) => applyChartChanges(tx, moved));
        const notes = (yield* readEditorChart(db)).singers[0]!.lines[1]!.notes;
        expect(notes).toHaveLength(1203);
        // Put in order by start: the last added starts first.
        expect(notes.slice(3, 6).map((n) => [n.id, n.pitch, n.edited])).toEqual([
          [3199, 62, true],
          [3198, 62, true],
          [3197, 62, true],
        ]);
        yield* db.transaction((tx) => applyChartChanges(tx, inverse([...added, ...moved])));
        expect(yield* readEditorChart(db)).toEqual(before);
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
            {
              table: "singer",
              id: singer.id,
              before: { index: 1, name: singer.name },
              after: { index: 1, name: "Mia" },
            },
          ]),
        );
        const after = yield* readEditorChart(db);
        expect(after.song.tags).toEqual(["live", "acoustic"]);
        expect(after.singers[0]!.name).toBe("Mia");
        expect((yield* readChart(db)).song.extraHeaders).toContainEqual(["TAGS", "live, acoustic"]);
        const stale = yield* Effect.flip(
          applyChartChanges(db, [
            { table: "singer", id: singer.id, before: { index: 1, name: null }, after: { index: 1, name: "Kai" } },
          ]),
        );
        expect(stale._tag).toBe("ChartOutOfStep");
      }),
    ),
  );

  it.effect("adds a second singer with a line and a note, and undoes it in reverse", () =>
    withProject((db, before) =>
      Effect.gen(function* () {
        const changes: ChartChange[] = [
          { table: "singer", id: 900, before: null, after: { index: 2, name: "Kai" } },
          { table: "line", id: 901, before: null, after: { singerId: 900, switchStart: null, switchEnd: null } },
          {
            table: "note",
            id: 902,
            before: null,
            after: { lineId: 901, start: 1, duration: 0.5, pitch: 60, lyric: "Hey", type: "normal", edited: true },
          },
        ];
        yield* db.transaction((tx) => applyChartChanges(tx, changes));
        const duet = yield* readEditorChart(db);
        expect(duet.singers.map((singer) => [singer.index, singer.name])).toEqual([
          [1, null],
          [2, "Kai"],
        ]);
        expect(duet.singers[1]!.lines[0]!.notes[0]!.lyric).toBe("Hey");
        yield* db.transaction((tx) => applyChartChanges(tx, inverse(changes)));
        expect(yield* readEditorChart(db)).toEqual(before);
      }),
    ),
  );

  it.effect("removes P1 after its rows and makes P2 the first singer, undone exactly", () =>
    withProject((db) =>
      Effect.gen(function* () {
        const added: ChartChange[] = [
          { table: "singer", id: 900, before: null, after: { index: 2, name: "Kai" } },
          { table: "line", id: 901, before: null, after: { singerId: 900, switchStart: null, switchEnd: null } },
        ];
        yield* db.transaction((tx) => applyChartChanges(tx, added));
        const before = yield* readEditorChart(db);
        const first = before.singers[0]!;
        const changes: ChartChange[] = [
          ...first.lines.flatMap((line) =>
            line.notes.map((n) => ({ table: "note", id: n.id, before: fields(n, line.id), after: null }) as const),
          ),
          ...first.lines.map(
            (line) =>
              ({
                table: "line",
                id: line.id,
                before: { singerId: first.id, switchStart: line.switchStart, switchEnd: line.switchEnd },
                after: null,
              }) as const,
          ),
          { table: "singer", id: first.id, before: { index: 1, name: null }, after: null },
          { table: "singer", id: 900, before: { index: 2, name: "Kai" }, after: { index: 1, name: "Kai" } },
        ];
        yield* db.transaction((tx) => applyChartChanges(tx, changes));
        const solo = yield* readEditorChart(db);
        expect(solo.singers.map((singer) => [singer.id, singer.index])).toEqual([[900, 1]]);
        yield* db.transaction((tx) => applyChartChanges(tx, inverse(changes)));
        expect(yield* readEditorChart(db)).toEqual(before);
      }),
    ),
  );

  it.effect("refuses to delete a singer that still has lines", () =>
    withProject((db, before) =>
      Effect.gen(function* () {
        const singer = before.singers[0]!;
        const error = yield* Effect.flip(
          db.transaction((tx) =>
            applyChartChanges(tx, [{ table: "singer", id: singer.id, before: { index: 1, name: null }, after: null }]),
          ),
        );
        expect(error._tag).toBe("ChartOutOfStep");
        expect(yield* readEditorChart(db)).toEqual(before);
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
