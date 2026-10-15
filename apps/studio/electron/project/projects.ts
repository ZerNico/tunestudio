import { randomUUID } from "node:crypto";

import { Context, Effect, Exit, FileSystem, Layer, Path, Ref, Scope } from "effect";

import {
  type DiskFull,
  type FileError,
  mapFileError,
  type NewerProjectVersion,
  type NotTuneStudioFile,
  type ProjectDamaged,
  ProjectNotOpen,
  quoted,
} from "../errors";
import { createDatabase, openDatabase, type ProjectDb } from "./database";

/** A project open in this app session. */
export interface ProjectSession {
  /** Random, unguessable; also the host of the project's `media://` URLs. */
  readonly id: string;
  /** The `.tunestudio` file (absolute, resolved). */
  readonly path: string;
  readonly db: ProjectDb;
}

export type OpenError = NotTuneStudioFile | NewerProjectVersion | ProjectDamaged | FileError;

interface ProjectsShape {
  /** Opens a project file, or returns its session if it is open already. */
  readonly open: (path: string) => Effect.Effect<ProjectSession, OpenError>;
  /**
   * Writes a new project to `path` and opens it. `populate` fills the empty database; the file
   * only appears at `path` once it succeeded (an existing file there is replaced), so a failed
   * or cancelled import leaves nothing behind.
   */
  readonly create: <E, R>(
    path: string,
    populate: (db: ProjectDb) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<ProjectSession, E | OpenError | DiskFull, R>;
  readonly get: (id: string) => Effect.Effect<ProjectSession, ProjectNotOpen>;
  /** Closes the project's database. Closing a project that isn't open does nothing. */
  readonly close: (id: string) => Effect.Effect<void>;
}

interface OpenEntry {
  session: ProjectSession;
  scope: Scope.Closeable;
}

/** The open `.tunestudio` files. Every project still open is closed when the runtime shuts down. */
export class Projects extends Context.Service<Projects, ProjectsShape>()("studio/Projects") {}

/** `appVersion` is recorded in the files this app creates or writes. */
export function projectsLayer(appVersion: string) {
  return Layer.effect(
    Projects,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const open = yield* Ref.make(new Map<string, OpenEntry>());

      yield* Effect.addFinalizer(() =>
        Effect.flatMap(Ref.getAndSet(open, new Map()), (entries) =>
          Effect.forEach(entries.values(), (entry) => Scope.close(entry.scope, Exit.void), { discard: true }),
        ),
      );

      const services = Context.make(FileSystem.FileSystem, fs).pipe(Context.add(Path.Path, paths));

      const register = (path: string, db: ProjectDb, scope: Scope.Closeable) =>
        Ref.modify(open, (entries) => {
          const session: ProjectSession = { id: randomUUID(), path, db };
          const next = new Map(entries);
          next.set(session.id, { session, scope });
          return [session, next];
        });

      const findByPath = (path: string) =>
        Effect.map(Ref.get(open), (entries) => [...entries.values()].find((entry) => entry.session.path === path));

      const close = (id: string) =>
        Effect.flatMap(
          Ref.modify(open, (entries) => {
            const entry = entries.get(id);
            const next = new Map(entries);
            next.delete(id);
            return [entry, next];
          }),
          (entry) => (entry ? Scope.close(entry.scope, Exit.void) : Effect.void),
        );

      /** The absolute path with symlinks in its folder resolved, so one file has one session. */
      const resolve = (path: string) =>
        Effect.gen(function* () {
          const absolute = paths.resolve(path);
          const folder = yield* fs
            .realPath(paths.dirname(absolute))
            .pipe(mapFileError(`the folder of ${quoted(paths.basename(absolute))}`, "open"));
          return paths.join(folder, paths.basename(absolute));
        });

      const openPath = (resolved: string) =>
        Effect.gen(function* () {
          const existing = yield* findByPath(resolved);
          if (existing) return existing.session;
          const scope = yield* Scope.make();
          const db = yield* openDatabase(resolved, paths.basename(resolved), appVersion).pipe(
            Scope.provide(scope),
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
          );
          return yield* register(resolved, db, scope);
        }).pipe(Effect.provideContext(services));

      const shape: ProjectsShape = {
        open: (path) => Effect.flatMap(resolve(path), openPath),

        create: (path, populate) =>
          Effect.gen(function* () {
            const target = yield* resolve(path);
            const name = paths.basename(target);
            const temporary = paths.join(paths.dirname(target), `.${name}.${randomUUID().slice(0, 8)}.tmp`);
            const removeTemporary = fs.remove(temporary, { force: true }).pipe(Effect.ignore);

            yield* Effect.scoped(
              Effect.gen(function* () {
                const db = yield* createDatabase(temporary, name, appVersion, randomUUID());
                yield* populate(db);
              }),
            ).pipe(Effect.onError(() => removeTemporary));

            // Replacing a project that is open: its session ends before the file is swapped.
            const replaced = yield* findByPath(target);
            if (replaced) yield* close(replaced.session.id);
            yield* fs.rename(temporary, target).pipe(
              mapFileError(quoted(name), "save"),
              Effect.onError(() => removeTemporary),
            );
            return yield* openPath(target);
          }).pipe(Effect.provideContext(services)),

        get: (id) =>
          Effect.flatMap(Ref.get(open), (entries) => {
            const entry = entries.get(id);
            return entry
              ? Effect.succeed(entry.session)
              : Effect.fail(new ProjectNotOpen({ message: "This project isn't open anymore. Open it again." }));
          }),

        close,
      };
      return shape;
    }),
  );
}
