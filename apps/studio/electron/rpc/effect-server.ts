/**
 * The Effect RPC server: the handlers of `NativeRpcs` (`src/lib/native/rpcs.ts`), served over the ports renderers
 * connect with (`port-protocol.ts`), on the main process runtime.
 *
 * While the calls move over from oRPC (`procedures.ts`), both run side by side, each on its own port.
 */
import { Cause, Effect, type Layer, type ManagedRuntime, Queue, Stream } from "effect";
import { RpcServer } from "effect/rpc";
import type { BrowserWindow } from "electron";

import { NativeRpcs } from "../../src/lib/native/rpcs";
import { Projects } from "../project/projects";
import { AppLog } from "../services/app-log";
import { Tools } from "../tools/tools";
import { makePortProtocol, type RpcPort } from "./port-protocol";
import { allowedPath, remember } from "./procedures";

/**
 * Writes a call's defects (bugs, not the user-facing errors it fails with) to the log, which the renderer's generic
 * "Something went wrong" message points to.
 */
function logDefects<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.tapDefect(effect, (defect) =>
    AppLog.use((log) => log.write("ERROR", "rpc", Cause.pretty(Cause.die(defect)))),
  );
}

/** A call's progress events, then its result (the shape `progress` in rpcs.ts describes). */
type ProgressEvent<P, A> =
  | { readonly _tag: "Progress"; readonly progress: P }
  | { readonly _tag: "Done"; readonly result: A };

/**
 * A call that reports progress through a callback, as a stream of its progress events and then its result. Stopping
 * the stream (the renderer cancelled) interrupts the work.
 */
export function progressStream<P, A, E, R>(
  run: (onProgress: (progress: P) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
): Stream.Stream<ProgressEvent<P, A>, E, R | AppLog> {
  return Stream.callback<ProgressEvent<P, A>, E, R | AppLog>((queue) =>
    logDefects(run((progress) => Effect.asVoid(Queue.offer(queue, { _tag: "Progress", progress })))).pipe(
      Effect.flatMap((result) => Queue.offer(queue, { _tag: "Done", result })),
      Effect.andThen(Queue.end(queue)),
    ),
  );
}

/** The calls' handlers, on the main process services. */
export const nativeHandlers = NativeRpcs.toLayer({
  "project.open": ({ path }) =>
    logDefects(
      Effect.gen(function* () {
        const allowed = yield* allowedPath(path);
        const session = yield* Projects.use((projects) => projects.open(allowed));
        return yield* remember(session);
      }),
    ),
  "tools.prepare": ({ tools, force }) =>
    progressStream((onProgress) =>
      Effect.gen(function* () {
        const installed = yield* Tools;
        yield* installed.ensure(tools, { force: force ?? false, onProgress });
        return yield* installed.status;
      }),
    ),
});

/**
 * Starts the server on `runtime` with `handlers` and resolves with the function that takes a renderer's port (with
 * its window) once it is ready. It runs until the runtime is disposed.
 */
export function startEffectRpc<R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  handlers: Layer.Layer<Layer.Success<typeof nativeHandlers>, never, R>,
) {
  return new Promise<(port: RpcPort, window: BrowserWindow | null) => void>((resolve) => {
    runtime.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const { protocol, accept } = yield* makePortProtocol<{ window: BrowserWindow | null }>();
          resolve((port, window) => accept(port, { window }));
          return yield* RpcServer.make(NativeRpcs, { disableFatalDefects: true }).pipe(
            Effect.provideService(RpcServer.Protocol, protocol),
            Effect.provide(handlers),
          );
        }),
      ),
    );
  });
}
