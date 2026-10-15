import { randomUUID } from "node:crypto";

import { Context, Effect, FileSystem, Layer, Path, Semaphore } from "effect";

import { DEFAULT_SETTINGS, type Settings, settingsFrom } from "../../src/lib/settings";
import { type FileError, mapFileError } from "../errors";

interface SettingsShape {
  /** The current settings; defaults for anything not set yet. */
  readonly get: Effect.Effect<Settings>;
  /** Replaces the settings and returns them as stored. */
  readonly set: (settings: Settings) => Effect.Effect<Settings, FileError>;
}

/** The app settings (`src/lib/settings.ts`), stored in the app's data directory. */
export class AppSettings extends Context.Service<AppSettings, SettingsShape>()("studio/AppSettings") {}

/**
 * Settings stored in `file` as `{ version: 1, settings }`. A missing or unreadable file means the
 * defaults, and a value that isn't valid anymore falls back to its default on its own.
 */
export function settingsLayer(file: string) {
  return Layer.effect(
    AppSettings,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const lock = yield* Semaphore.make(1);

      const read = fs.readFileString(file).pipe(
        Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as unknown)),
        Effect.map((stored) =>
          settingsFrom(typeof stored === "object" && stored !== null && "settings" in stored ? stored.settings : null),
        ),
        Effect.orElseSucceed(() => DEFAULT_SETTINGS),
      );

      const write = (settings: Settings) => {
        const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
        return Effect.gen(function* () {
          yield* fs.makeDirectory(paths.dirname(file), { recursive: true });
          yield* fs.writeFileString(temporary, `${JSON.stringify({ version: 1, settings }, null, 2)}\n`);
          yield* fs.rename(temporary, file);
        }).pipe(
          Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
          mapFileError("the settings", "save"),
        );
      };

      return {
        get: lock.withPermits(1)(read),
        set: (settings) => {
          const cleaned = settingsFrom(settings);
          return lock.withPermits(1)(Effect.as(write(cleaned), cleaned));
        },
      } satisfies SettingsShape;
    }),
  );
}
