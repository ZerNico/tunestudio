/** What the handlers share: the calling window, checked paths, open projects and progress streams. */
import { Context, Effect, Exit, Path, Queue, Stream } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";
import type { BrowserWindow } from "electron";

import type { NativeRpcs } from "../../../src/lib/native/contract";
import type { OpenedProject } from "../../../src/lib/native/types";
import { FileSystemFailure, quoted } from "../../errors";
import { recentEntry } from "../../project/overview";
import { Projects, type ProjectSession } from "../../project/projects";
import { AppLog } from "../../services/app-log";
import { Desktop } from "../../services/desktop";
import { Drafts } from "../../services/drafts";
import { normalizePath, notAllowed, PathGrants } from "../../services/path-grants";
import { Recents } from "../../services/recents";
import type { Windows } from "../../windows";

type Rpcs = RpcGroup.Rpcs<typeof NativeRpcs>;

/** The handlers of the calls in `Group` (`"project"`: `project.open`, ...), as the contract types them. */
export type GroupHandlers<Group extends string> = Pick<
  RpcGroup.HandlersFrom<Rpcs>,
  Extract<Rpc.Tag<Rpcs>, `${Group}.${string}`>
>;

/**
 * The windows calls come from, by their connection's client id (`port-protocol.ts`), for dialogs to belong to; and
 * which window shows which project (`windows.ts`; none in tests).
 */
export class Callers extends Context.Service<
  Callers,
  { readonly windowOf: (clientId: number) => BrowserWindow | null; readonly windows: Windows | null }
>()("studio/RpcCallers") {}

export const windowOf = (client: { readonly id: number }) => Callers.useSync((callers) => callers.windowOf(client.id));

/** `path`, if the user picked or dropped it in this session (or it is a listed recent project). */
export const allowedPath = (path: string) =>
  Effect.gen(function* () {
    const grants = yield* PathGrants;
    if (!(yield* grants.allows(path))) return yield* notAllowed();
    return normalizePath(path);
  });

/**
 * An open project, for calls that may take long (FFmpeg or a model downloaded first): closing it doesn't wait for them,
 * only for a transaction of theirs in progress, and each change of theirs is one transaction.
 */
export const project = (id: string) => Projects.use((projects) => projects.get(id));

/** Runs `use` on an open project as a call closing it waits for. */
export const withProject = <A, E, R>(id: string, use: (session: ProjectSession) => Effect.Effect<A, E, R>) =>
  Projects.use((projects) => projects.track(id, use));

export const grant = (path: string | null) =>
  path === null
    ? Effect.succeed(null)
    : Effect.as(
        PathGrants.use((grants) => grants.grant(path)),
        path,
      );

/** Puts an opened project at the top of the recents; failing to save the list doesn't stop the open. */
const remember = (session: ProjectSession) =>
  Effect.gen(function* () {
    const desktop = yield* Desktop;
    const recents = yield* Recents;
    const entry = yield* recentEntry(session, desktop.thumbnail).pipe(Effect.orElseSucceed(() => null));
    if (entry) {
      yield* recents
        .add(entry)
        .pipe(Effect.catch((error) => AppLog.use((log) => log.write("WARN", "recents", error.message))));
    }
    yield* PathGrants.use((grants) => grants.grant(session.path));
    return { id: session.id, path: session.path } satisfies OpenedProject;
  });

/** A project opened for the window `client` is in: remembered in recents, and that window shows it. */
export const openedIn = (client: { readonly id: number }, session: ProjectSession) =>
  Effect.gen(function* () {
    const opened = yield* remember(session);
    const window = yield* windowOf(client);
    const { windows } = yield* Callers;
    if (window) windows?.show(window, { id: opened.id, path: session.path });
    return opened;
  });

/**
 * A new project can't replace one a window shows: that window's edits would go on in a file that is gone. (Creating
 * it closes a session nobody shows.)
 */
export const notShown = (target: string) =>
  Effect.gen(function* () {
    const { windows } = yield* Callers;
    if (!windows?.showing(target)) return;
    const name = (yield* Path.Path).basename(target);
    return yield* new FileSystemFailure({
      message: `${quoted(name)} is open in Tune Studio. Close it first, or save the new project under another name.`,
    });
  });

/** Cancelled just as it finished: the renderer won't hear of this draft to discard it. */
export const discardUndelivered = (draft: { readonly draftId: string }) =>
  Drafts.use((drafts) => drafts.discard(draft.draftId)).pipe(Effect.ignore);

/** A call's progress events, then its result (the shape `progress` in contract.ts describes). */
type ProgressEvent<P, A> =
  | { readonly _tag: "Progress"; readonly progress: P }
  | { readonly _tag: "Done"; readonly result: A };

/**
 * Long work (an import, downloads) as a stream of its progress events and then its result. Stopping the stream (the
 * renderer cancelled) interrupts the work, which cleans up after itself. Work that finished anyway, with a result the
 * renderer never got, is handed to `onUndelivered`.
 */
export function progressStream<P, A, E, R, R2 = never>(
  run: (onProgress: (progress: P) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
  onUndelivered?: (result: A) => Effect.Effect<void, never, R2>,
): Stream.Stream<ProgressEvent<P, A>, E, R | R2> {
  let finished: { result: A } | undefined;
  return Stream.callback<ProgressEvent<P, A>, E, R>((queue) =>
    run((progress) => Effect.asVoid(Queue.offer(queue, { _tag: "Progress", progress }))).pipe(
      Effect.flatMap((result) => {
        finished = { result };
        return Queue.offer(queue, { _tag: "Done", result });
      }),
      Effect.andThen(Queue.end(queue)),
    ),
  ).pipe(
    // The renderer doesn't stop a stream once it has the result, so only a stream stopped before then lost it.
    Stream.onExit((exit): Effect.Effect<void, never, R2> =>
      Exit.isFailure(exit) && finished && onUndelivered ? onUndelivered(finished.result) : Effect.void,
    ),
  );
}
