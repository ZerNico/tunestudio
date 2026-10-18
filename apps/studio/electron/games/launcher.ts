import { spawn } from "node:child_process";

import { Context, Effect, Layer } from "effect";

/** How a start went: the game started, or it never did (with node's error code). */
export type LaunchOutcome = { readonly kind: "started" } | { readonly kind: "failed"; readonly code: string };

interface GameLauncherShape {
  /** Starts `program` on its own (it outlives the app). */
  readonly start: (
    program: string,
    args: readonly string[],
    env: Record<string, string>,
  ) => Effect.Effect<LaunchOutcome>;
}

/** Starts games. The app's starts real processes (`gameLauncherLayer`); tests record what would have run. */
export class GameLauncher extends Context.Service<GameLauncher, GameLauncherShape>()("studio/GameLauncher") {}

/**
 * Starts the game detached, with no terminal of ours and nothing read from it, and lets go of it once it has started.
 * Not Effect's `ChildProcessSpawner`: that ties the process to a scope and stops it with the scope, and a game has to
 * keep running after the call (and the app) ends. What the game does after starting isn't watched: one already open
 * may take the start over and quit (Tune Perfect), and a crash shows as no game window.
 */
export const gameLauncherLayer = Layer.succeed(GameLauncher, {
  start: (program, args, env) =>
    Effect.callback<LaunchOutcome>((resume) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(program, [...args], { detached: true, stdio: "ignore", env, windowsHide: false });
      } catch (error) {
        resume(Effect.succeed({ kind: "failed", code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" }));
        return;
      }
      child.once("error", (error: NodeJS.ErrnoException) => {
        resume(Effect.succeed({ kind: "failed", code: error.code ?? "UNKNOWN" }));
      });
      child.once("spawn", () => {
        child.unref();
        resume(Effect.succeed({ kind: "started" }));
      });
    }),
});
