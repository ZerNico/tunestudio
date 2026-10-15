import path from "node:path";

import { ManagedRuntime } from "effect";

import type { Logger } from "./logger";
import { appLogLayer } from "./services/app-log";
import { desktopLayer } from "./services/desktop-electron";
import { studioServices } from "./services/layer";
import { COVER_HOSTS, downloadsLayer, LYRICS_HOSTS, MODEL_HOSTS, THUMBNAIL_HOSTS, TOOL_HOSTS } from "./tools/downloads";

export interface RuntimeOptions {
  /** The app's data directory (recent projects live there). */
  dataDir: string;
  appVersion: string;
  /** Where the native addon is. */
  nativeFolder: string;
  /** No downloads at all (tests): tool checks fail as if offline. */
  offline?: boolean;
}

/**
 * The main process's Effect runtime: every service the RPC handlers, the media protocol and
 * background work use, built once at startup and disposed on quit (which closes open projects).
 */
export function makeRuntime(logger: Logger, options: RuntimeOptions) {
  return ManagedRuntime.make(
    studioServices({
      appVersion: options.appVersion,
      recentsFile: path.join(options.dataDir, "recent-projects.json"),
      settingsFile: path.join(options.dataDir, "settings.json"),
      draftsFolder: path.join(options.dataDir, "drafts"),
      toolsFolder: path.join(options.dataDir, "tools"),
      modelsFolder: path.join(options.dataDir, "models"),
      nativeFolder: options.nativeFolder,
      downloads: downloadsLayer({
        hosts: options.offline
          ? []
          : [...TOOL_HOSTS, ...THUMBNAIL_HOSTS, ...COVER_HOSTS, ...LYRICS_HOSTS, ...MODEL_HOSTS],
      }),
      log: appLogLayer(logger),
      desktop: desktopLayer,
    }),
  );
}

export type StudioRuntime = ReturnType<typeof makeRuntime>;
