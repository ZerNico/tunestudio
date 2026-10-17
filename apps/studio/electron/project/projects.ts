import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { Context, Effect, Exit, FileSystem, Layer, Path, Ref, Scope, Semaphore } from "effect";

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
   * only appears at `path` once it succeeded (an existing file there is replaced, and its session
   * closed), so a failed or cancelled import leaves nothing behind.
   */
  readonly create: <E, R>(
    path: string,
    populate: (db: ProjectDb) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<ProjectSession, E | OpenError | DiskFull, R>;
  readonly get: (id: string) => Effect.Effect<ProjectSession, ProjectNotOpen>;
  /**
   * Runs `use` on the open project as work `close` waits for: a save in flight finishes before the database closes.
   * For short calls; ones that may take long (downloading a tool first, separating, charting) use `get`.
   */
  readonly track: <A, E, R>(
    id: string,
    use: (session: ProjectSession) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProjectNotOpen, R>;
  /**
   * Closes the project's database once the work `track` runs on it is done. Closing a project that isn't open does
   * nothing.
   */
  readonly close: (id: string) => Effect.Effect<void>;
}

const notOpen = () => new ProjectNotOpen({ message: "This project isn't open anymore. Open it again." });

/** As many calls as can be tracked on one project at once; closing takes them all. */
const ALL_USERS = 1_000_000;

interface OpenEntry {
  session: ProjectSession;
  scope: Scope.Closeable;
  /** One permit per tracked call. */
  users: Semaphore.Semaphore;
  /** Set when closing starts: tracked calls that waited for it find the project closed. */
  closing: boolean;
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

      const services = Context.make(FileSystem.FileSystem, fs).pipe(Context.add(Path.Path, paths));

      // Opening, creating and closing one file take turns, so it never has two sessions or connections.
      const pathLocks = new Map<string, Semaphore.Semaphore>();
      const lockFor = (path: string) => {
        let lock = pathLocks.get(path);
        if (!lock) pathLocks.set(path, (lock = Semaphore.makeUnsafe(1)));
        return lock;
      };

      const register = (path: string, db: ProjectDb, scope: Scope.Closeable) =>
        Ref.modify(open, (entries) => {
          const session: ProjectSession = { id: randomUUID(), path, db };
          const next = new Map(entries);
          next.set(session.id, { session, scope, users: Semaphore.makeUnsafe(ALL_USERS), closing: false });
          return [session, next];
        });

      const findByPath = (path: string) =>
        Effect.map(Ref.get(open), (entries) => [...entries.values()].find((entry) => entry.session.path === path));

      /** Waits for the tracked calls, then for the connection (another call's transaction), then closes it. */
      const closeEntry = (entry: OpenEntry) =>
        Effect.andThen(
          Effect.sync(() => void (entry.closing = true)),
          entry.users.withPermits(ALL_USERS)(
            Effect.andThen(
              entry.session.db.run(sql`SELECT 1`).pipe(Effect.ignore),
              Scope.close(entry.scope, Exit.void),
            ),
          ),
        );

      // Saves in flight finish first (quitting gives this a few seconds).
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(Ref.getAndSet(open, new Map()), (entries) =>
          Effect.forEach(entries.values(), closeEntry, { discard: true, concurrency: "unbounded" }),
        ),
      );

      const close = (id: string) =>
        Effect.flatMap(Ref.get(open), (entries) => {
          const found = entries.get(id);
          if (!found) return Effect.void;
          return lockFor(found.session.path).withPermits(1)(
            Effect.flatMap(
              Ref.modify(open, (current) => {
                const entry = current.get(id);
                const next = new Map(current);
                next.delete(id);
                return [entry, next];
              }),
              (entry) => (entry ? closeEntry(entry) : Effect.void),
            ),
          );
        });

      /** The absolute path with symlinks in its folder resolved, so one file has one session. */
      const resolve = (path: string) =>
        Effect.gen(function* () {
          const absolute = paths.resolve(path);
          const folder = yield* fs
            .realPath(paths.dirname(absolute))
            .pipe(mapFileError(`the folder of ${quoted(paths.basename(absolute))}`, "open"));
          return paths.join(folder, paths.basename(absolute));
        });

      /** Opens `resolved`, or returns its session; run it under the file's lock. */
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
        open: (path) =>
          Effect.flatMap(resolve(path), (resolved) => lockFor(resolved).withPermits(1)(openPath(resolved))),

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

            return yield* lockFor(target).withPermits(1)(
              Effect.gen(function* () {
                // Replacing a project that is open: its session ends (after the calls on it) before the file is
                // swapped. The app doesn't let a new project replace one a window shows (`rpc/procedures.ts`).
                const replaced = yield* Ref.modify(open, (entries) => {
                  const entry = [...entries.values()].find((candidate) => candidate.session.path === target);
                  if (!entry) return [undefined, entries];
                  const next = new Map(entries);
                  next.delete(entry.session.id);
                  return [entry, next];
                });
                if (replaced) yield* closeEntry(replaced);
                yield* fs.rename(temporary, target).pipe(
                  mapFileError(quoted(name), "save"),
                  Effect.onError(() => removeTemporary),
                );
                return yield* openPath(target);
              }),
            );
          }).pipe(Effect.provideContext(services)),

        get: (id) =>
          Effect.flatMap(Ref.get(open), (entries) => {
            const entry = entries.get(id);
            return entry ? Effect.succeed(entry.session) : Effect.fail(notOpen());
          }),

        track: <A, E, R>(id: string, use: (session: ProjectSession) => Effect.Effect<A, E, R>) =>
          Effect.flatMap(Ref.get(open), (entries): Effect.Effect<A, E | ProjectNotOpen, R> => {
            const entry = entries.get(id);
            if (!entry) return Effect.fail(notOpen());
            return entry.users.withPermits(1)(
              Effect.suspend((): Effect.Effect<A, E | ProjectNotOpen, R> =>
                entry.closing ? Effect.fail(notOpen()) : use(entry.session),
              ),
            );
          }),

        close,
      };
      return shape;
    }),
  );
}
