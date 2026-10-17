/** The app around the projects: the log, windows, recent projects, revealing files and the settings. */
import { Effect } from "effect";

import type { RecentProjectEntry } from "../../../src/lib/native/types";
import { AppLog } from "../../services/app-log";
import { Desktop } from "../../services/desktop";
import { normalizePath } from "../../services/path-grants";
import { Recents } from "../../services/recents";
import { AppSettings } from "../../services/settings";
import { allowedPath, Callers, grant, type GroupHandlers, windowOf } from "./shared";

export const appHandlers = {
  "app.log": (input) => AppLog.use((log) => log.write(input.level.toUpperCase(), "renderer", input.message)),

  "windows.takeOpenRequest": (_, { client }) =>
    Effect.gen(function* () {
      const { windows } = yield* Callers;
      return windows?.takeOpenRequest(yield* windowOf(client)) ?? null;
    }),
  "windows.add": () => Callers.useSync(({ windows }) => void windows?.add()),

  "recents.list": () =>
    Effect.gen(function* () {
      const projects = yield* Recents.use((recents) => recents.list);
      // The listed projects may be opened, revealed or restored after removing them.
      yield* Effect.forEach(projects, (entry) => grant(entry.path), { discard: true });
      return projects;
    }),
  "recents.remove": (input) => Recents.use((recents) => recents.remove(normalizePath(input.path))),
  "recents.restore": (input) =>
    Effect.flatMap(allowedPath(input.path), (path) =>
      Recents.use((recents) => recents.restore({ ...input, path } satisfies RecentProjectEntry)),
    ),

  "files.reveal": (input) =>
    Effect.flatMap(allowedPath(input.path), (path) => Desktop.use((desktop) => desktop.reveal(path))),

  "settings.get": () => AppSettings.use((settings) => settings.get),
  "settings.set": (input) => AppSettings.use((settings) => settings.set(input)),
} satisfies GroupHandlers<"app" | "windows" | "recents" | "files" | "settings">;
