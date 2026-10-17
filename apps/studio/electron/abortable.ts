import { Effect } from "effect";

/**
 * `Effect.tryPromise` for work that keeps running until it notices its signal (native separation and listening,
 * downloads still writing a file): interrupting aborts it and then waits for it to stop, so what runs after the
 * interruption (removing its folder, the next job) never races it.
 */
export function abortable<A, E>(options: {
  readonly try: (signal: AbortSignal) => Promise<A>;
  readonly catch: (error: unknown) => E;
}) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const started = yield* Effect.sync(() => {
        try {
          return options.try(controller.signal);
        } catch (error) {
          return Promise.reject(error);
        }
      });
      return yield* restore(Effect.tryPromise({ try: () => started, catch: options.catch })).pipe(
        Effect.onInterrupt(() =>
          Effect.andThen(
            Effect.sync(() => controller.abort()),
            Effect.promise(() =>
              started.then(
                () => {},
                () => {},
              ),
            ),
          ),
        ),
      );
    }),
  );
}
