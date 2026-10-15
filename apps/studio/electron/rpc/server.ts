/**
 * The RPC server: the handlers of `NativeRpcs` (`procedures.ts`) served over the ports renderers connect with
 * (`port-protocol.ts`), on the main process runtime.
 */
import { Cause, Effect, ErrorReporter, Layer, type ManagedRuntime } from "effect";
import { RpcServer } from "effect/rpc";
import type { BrowserWindow } from "electron";

import { NativeRpcs } from "../../src/lib/native/contract";
import { AppLog } from "../services/app-log";
import { makePortProtocol, type RpcPort } from "./port-protocol";
import { Callers, type nativeHandlers } from "./procedures";

/**
 * Writes failed calls with a defect (a bug in a handler, an answer that doesn't fit its schema) to the log, which the
 * renderer's generic "Something went wrong" message points to. Failures the user can act on aren't logged.
 */
const defectLogger = (write: (message: string) => void): ErrorReporter.ErrorReporter => ({
  [ErrorReporter.TypeId]: ErrorReporter.TypeId,
  report: ({ cause }) => {
    if (Cause.hasDies(cause)) write(Cause.pretty(cause));
  },
});

/**
 * Starts the server on `runtime` with `handlers` and resolves with the function that takes a renderer's port (with
 * its window) once it is ready. It runs until the runtime is disposed.
 */
export function startRpcServer<R>(
  runtime: ManagedRuntime.ManagedRuntime<R | AppLog, never>,
  handlers: Layer.Layer<Layer.Success<typeof nativeHandlers>, never, R | Callers>,
) {
  return new Promise<(port: RpcPort, window: BrowserWindow | null) => void>((resolve) => {
    runtime.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const log = yield* AppLog;
          const { protocol, accept, metaOf } = yield* makePortProtocol<{ window: BrowserWindow | null }>();
          resolve((port, window) => accept(port, { window }));
          const callers = Layer.succeed(Callers, { windowOf: (clientId) => metaOf(clientId)?.window ?? null });
          const reporters = new Set([
            defectLogger((message) => void Effect.runFork(log.write("ERROR", "rpc", message))),
          ]);
          return yield* RpcServer.make(NativeRpcs, { disableFatalDefects: true }).pipe(
            Effect.provideService(RpcServer.Protocol, protocol),
            Effect.provide(Layer.provide(handlers, callers)),
            Effect.provideService(ErrorReporter.CurrentErrorReporters, reporters),
          );
        }),
      ),
    );
  });
}
