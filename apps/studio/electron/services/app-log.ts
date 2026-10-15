import { Context, Effect, Layer } from "effect";

import type { Logger } from "../logger";

/** The app's log file, as a service, so tests can provide one that records instead of writing. */
export class AppLog extends Context.Service<
  AppLog,
  { readonly write: (level: string, target: string, message: string) => Effect.Effect<void> }
>()("studio/AppLog") {}

/** Writes through the main process logger. */
export function appLogLayer(logger: Logger) {
  return Layer.succeed(AppLog, {
    write: (level, target, message) => Effect.sync(() => logger.write(level, target, message)),
  });
}
