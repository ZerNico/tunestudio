import { implement, ORPCError } from "@orpc/server";
import { Effect, type ManagedRuntime } from "effect";
import type { BrowserWindow } from "electron";

import { contract } from "../../src/lib/native/contract";

export interface RpcContext {
  /** The window whose renderer opened the connection. */
  window: BrowserWindow | null;
}

export const os = implement(contract).$context<RpcContext>();

/**
 * Runs one RPC call's Effect on the main process runtime. Typed failures are meant for the
 * user, so they reach the renderer as BAD_REQUEST with their message (and their `_tag` as `data.tag`,
 * so the renderer can tell kinds apart without matching text); defects stay internal and
 * arrive as oRPC's generic INTERNAL_SERVER_ERROR. Aborting the call interrupts the Effect.
 */
export function runRpc<A, E extends { readonly message: string }, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  effect: Effect.Effect<A, E, R>,
  signal?: AbortSignal,
): Promise<A> {
  return runtime.runPromise(
    Effect.mapError(
      effect,
      (error) =>
        new ORPCError("BAD_REQUEST", {
          message: error.message,
          data: { tag: "_tag" in error && typeof error._tag === "string" ? error._tag : undefined },
          cause: error,
        }),
    ),
    { signal },
  );
}
