import path from "node:path";

import { Context, Effect, Layer, Ref } from "effect";

import { PathNotAllowed } from "../errors";

interface PathGrantsShape {
  /** Lets the renderer use `path` (and, for a folder, nothing more) for the rest of the session. */
  readonly grant: (path: string) => Effect.Effect<void>;
  readonly allows: (path: string) => Effect.Effect<boolean>;
}

/**
 * The paths the renderer may hand back to main: those the user picked in a dialog or dropped
 * on the window in this session. Recent projects are allowed separately (see `Recents`).
 */
export class PathGrants extends Context.Service<PathGrants, PathGrantsShape>()("studio/PathGrants") {}

/** The form grants are stored and compared in: absolute and normalized. */
export function normalizePath(value: string): string {
  return path.resolve(value);
}

export const pathGrantsLayer = Layer.effect(
  PathGrants,
  Effect.gen(function* () {
    const granted = yield* Ref.make(new Set<string>());
    return {
      grant: (value) => Ref.update(granted, (set) => new Set(set).add(normalizePath(value))),
      allows: (value) => Effect.map(Ref.get(granted), (set) => set.has(normalizePath(value))),
    };
  }),
);

/** The message for a path the renderer wasn't given. */
export function notAllowed(): PathNotAllowed {
  return new PathNotAllowed({
    message: "Choose the file again: Tune Studio can only use files you picked or dropped.",
  });
}
