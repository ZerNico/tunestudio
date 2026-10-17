import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";

import { ProjectNotOpen } from "../errors";
import { tempDir } from "../testing";
import { Projects, projectsLayer } from "./projects";
import { song } from "./schema";

let cleanup = () => {};
afterEach(() => cleanup());

function setup() {
  const made = tempDir();
  cleanup = made.cleanup;
  const layer = projectsLayer("1.0.0").pipe(Layer.provideMerge(NodeServices.layer));
  return { file: path.join(made.dir, "Song.tunestudio"), layer };
}

/** The song titles in the file, read without the app. */
function titles(file: string) {
  const raw = new DatabaseSync(file, { readOnly: true });
  const rows = raw
    .prepare("SELECT title FROM song")
    .all()
    .map((row) => row.title);
  raw.close();
  return rows;
}

const addSong = (title: string) => ({ id: 1, title, artist: "A", bpm: 300 });

describe("Projects", () => {
  it.live("closes a project only once the calls on it are done, so a save in flight is kept", () => {
    const { file, layer } = setup();
    return Effect.gen(function* () {
      const projects = yield* Projects;
      const session = yield* projects.create(file, () => Effect.void);
      const saving = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const save = yield* Effect.forkChild(
        projects.track(session.id, (open) =>
          open.db.transaction((tx) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(saving);
              yield* tx.insert(song).values(addSong("Saved"));
            }),
          ),
        ),
      );
      yield* Deferred.await(started);
      const closing = yield* Effect.forkChild(projects.close(session.id));
      // Closing has begun: new calls find the project closed.
      yield* Effect.yieldNow;
      const late = yield* Effect.flip(projects.track(session.id, () => Effect.void));
      expect(late).toBeInstanceOf(ProjectNotOpen);
      yield* Deferred.succeed(saving, undefined);
      yield* Fiber.join(save);
      yield* Fiber.join(closing);
      expect(titles(file)).toEqual(["Saved"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("waits for a transaction of a call it doesn't track before closing", () => {
    const { file, layer } = setup();
    return Effect.gen(function* () {
      const projects = yield* Projects;
      const session = yield* projects.create(file, () => Effect.void);
      const writing = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const job = yield* Effect.forkChild(
        session.db.transaction((tx) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(writing);
            yield* tx.insert(song).values(addSong("Separated"));
          }),
        ),
      );
      yield* Deferred.await(started);
      const closing = yield* Effect.forkChild(projects.close(session.id));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(writing, undefined);
      yield* Fiber.join(job);
      yield* Fiber.join(closing);
      expect(titles(file)).toEqual(["Separated"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("opens one file once, however many ask at the same time", () => {
    const { file, layer } = setup();
    return Effect.gen(function* () {
      const projects = yield* Projects;
      const created = yield* projects.create(file, () => Effect.void);
      yield* projects.close(created.id);
      const sessions = yield* Effect.all(
        Array.from({ length: 4 }, () => projects.open(file)),
        { concurrency: "unbounded" },
      );
      expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});
