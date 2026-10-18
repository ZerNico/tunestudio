import { spawn } from "node:child_process";

import { Context, Effect, Layer } from "effect";

/** How a start went: still running after the wait, exited (with its code, null for a signal), or never started. */
export type LaunchOutcome =
  | { readonly kind: "running" }
  | { readonly kind: "exited"; readonly code: number | null }
  | { readonly kind: "failed"; readonly code: string };

interface GameLauncherShape {
  /** Starts `program` on its own (it outlives the app) and reports how it went after a short wait. */
  readonly start: (
    program: string,
    args: readonly string[],
    env: Record<string, string>,
  ) => Effect.Effect<LaunchOutcome>;
}

/** Starts games. The app's starts real processes (`gameLauncherLayer`); tests record what would have run. */
export class GameLauncher extends Context.Service<GameLauncher, GameLauncherShape>()("studio/GameLauncher") {}

/**
 * Starts the game detached, with no terminal of ours and nothing read from it, and lets go of it. Not Effect's
 * `ChildProcessSpawner`: that ties the process to a scope and stops it with the scope, and a game has to keep running
 * after the call (and the app) ends. A game that exits within `settleMs` didn't really start: one already open
 * hands over to itself and quits (Tune Perfect), or it crashed.
 */
export function gameLauncherLayer(settleMs: number) {
  return Layer.succeed(GameLauncher, {
    start: (program, args, env) =>
      Effect.callback<LaunchOutcome>((resume) => {
        let settled = false;
        const finish = (outcome: LaunchOutcome) => {
          if (settled) return;
          settled = true;
          resume(Effect.succeed(outcome));
        };
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(program, [...args], { detached: true, stdio: "ignore", env, windowsHide: false });
        } catch (error) {
          finish({ kind: "failed", code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" });
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        child.once("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          finish({ kind: "failed", code: error.code ?? "UNKNOWN" });
        });
        child.once("spawn", () => {
          child.unref();
          timer = setTimeout(() => finish({ kind: "running" }), settleMs);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          finish({ kind: "exited", code });
        });
      }),
  });
}
