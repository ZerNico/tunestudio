import { randomUUID } from "node:crypto";

import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";

import type { RecentProjectEntry } from "../../src/lib/native/types";
import { type FileError, mapFileError } from "../errors";

/** One recent project, as stored. */
const RecentProject = Schema.Struct({
  path: Schema.String,
  lastOpened: Schema.String,
  title: Schema.String,
  artist: Schema.String,
  cover: Schema.optional(Schema.String),
});

/** `recent-projects.json` in the app's data directory. */
export const RecentsFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    projects: Schema.Array(RecentProject),
  }),
);

/** The list keeps this many projects. */
const LIMIT = 50;

interface RecentsShape {
  /**
   * The projects, newest first. Files that no longer exist are dropped from the list, but only when their folder is
   * still there: one on a drive that isn't plugged in (or a share that isn't connected) stays.
   */
  readonly list: Effect.Effect<RecentProjectEntry[]>;
  /** Adds or moves a project to the top. */
  readonly add: (entry: RecentProjectEntry) => Effect.Effect<void, FileError>;
  readonly remove: (path: string) => Effect.Effect<void, FileError>;
  /** Puts a removed project back where its `lastOpened` sorts it. */
  readonly restore: (entry: RecentProjectEntry) => Effect.Effect<void, FileError>;
  /** Whether `path` is in the list. */
  readonly has: (path: string) => Effect.Effect<boolean>;
}

/** The recent projects list (docs/project-format.md, "Recents"). */
export class Recents extends Context.Service<Recents, RecentsShape>()("studio/Recents") {}

const decode = Schema.decodeUnknownEffect(RecentsFile);
const encode = Schema.encodeSync(RecentsFile);

/** Recents stored in `file`. A missing or unreadable file is an empty list. */
export function recentsLayer(file: string) {
  return Layer.effect(
    Recents,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const lock = yield* Semaphore.make(1);

      const read = fs.readFileString(file).pipe(
        Effect.flatMap((text) => decode(text)),
        Effect.map((stored) => stored.projects.map((project) => ({ ...project }))),
        Effect.orElseSucceed((): RecentProjectEntry[] => []),
      );

      const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => true));

      const write = (projects: RecentProjectEntry[]) => {
        const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
        return Effect.gen(function* () {
          yield* fs.makeDirectory(paths.dirname(file), { recursive: true });
          yield* fs.writeFileString(temporary, encode({ version: 1, projects }));
          yield* fs.rename(temporary, file);
        }).pipe(
          Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
          mapFileError("the recent projects list", "save"),
        );
      };

      const update = (change: (projects: RecentProjectEntry[]) => RecentProjectEntry[]) =>
        lock.withPermits(1)(Effect.flatMap(read, (projects) => write(change(projects).slice(0, LIMIT))));

      const shape: RecentsShape = {
        list: lock.withPermits(1)(
          Effect.gen(function* () {
            const projects = yield* read;
            const kept = yield* Effect.filter(projects, (project) =>
              Effect.flatMap(exists(project.path), (found) =>
                found ? Effect.succeed(true) : Effect.map(exists(paths.dirname(project.path)), (folder) => !folder),
              ),
            );
            if (kept.length !== projects.length) yield* write(kept).pipe(Effect.ignore);
            return kept;
          }),
        ),
        add: (entry) => update((projects) => [entry, ...projects.filter((project) => project.path !== entry.path)]),
        remove: (path) => update((projects) => projects.filter((project) => project.path !== path)),
        restore: (entry) =>
          update((projects) =>
            [...projects.filter((project) => project.path !== entry.path), entry].toSorted((a, b) =>
              b.lastOpened.localeCompare(a.lastOpened),
            ),
          ),
        has: (path) => Effect.map(read, (projects) => projects.some((project) => project.path === path)),
      };
      return shape;
    }),
  );
}
