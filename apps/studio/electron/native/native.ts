import { createRequire } from "node:module";
import path from "node:path";

import { Context, Effect, Layer } from "effect";

import type * as Addon from "../../native/index";
import { EngineUnavailable } from "../errors";

/** The native addon (`native/`): voice separation and Whisper, run on worker threads. */
export type NativeAddon = typeof Addon;

interface NativeShape {
  /** The addon, loaded on first use. */
  readonly addon: Effect.Effect<NativeAddon, EngineUnavailable>;
}

export class Native extends Context.Service<Native, NativeShape>()("studio/Native") {}

/**
 * The addon from `folder`, which holds napi's loader (`index.cjs`), the build for this platform
 * and the WebGPU library next to it. It sits outside the app archive, since the system can only
 * load libraries from real files.
 */
export function nativeLayer(folder: string) {
  return Layer.effect(
    Native,
    Effect.gen(function* () {
      const load = yield* Effect.cached(
        Effect.try({
          try: () => {
            const loader = path.join(folder, "index.cjs");
            return createRequire(loader)(loader) as NativeAddon;
          },
          catch: (error) =>
            new EngineUnavailable({
              message: `Tune Studio's audio engine couldn't be loaded. Reinstalling the app may help. (${
                error instanceof Error ? error.message : String(error)
              })`,
            }),
        }),
      );
      return { addon: load } satisfies NativeShape;
    }),
  );
}
