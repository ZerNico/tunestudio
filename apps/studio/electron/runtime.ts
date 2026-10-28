import os from "node:os";
import path from "node:path";

import { ManagedRuntime } from "effect";

import type { Logger } from "./logger";
import { appLogLayer } from "./services/app-log";
import { desktopLayer } from "./services/desktop-electron";
import { studioServices } from "./services/layer";
import { COVER_HOSTS, downloadsLayer, LYRICS_HOSTS, MODEL_HOSTS, THUMBNAIL_HOSTS, TOOL_HOSTS } from "./tools/downloads";
import type { UpdatesOptions } from "./updates/updates";

export interface RuntimeOptions {
  /** The app's data directory (recent projects live there). */
  dataDir: string;
  appVersion: string;
  /** Where the native addon is. */
  nativeFolder: string;
  /** No downloads at all (tests): tool checks fail as if offline. */
  offline?: boolean;
  /** Where macOS apps (the games) are looked for, instead of the Applications folders (tests). */
  appFolders?: readonly string[];
  /** How the packaged app updates itself; without, it never does. */
  updates?: UpdatesOptions;
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
      tryFolder: path.join(options.dataDir, "try-in-game"),
      gamePlatform: { os: process.platform, home: os.homedir(), env: process.env, appFolders: options.appFolders },
      toolsFolder: path.join(options.dataDir, "tools"),
      modelsFolder: path.join(options.dataDir, "models"),
      nativeFolder: options.nativeFolder,
      downloads: downloadsLayer({
        hosts: options.offline
          ? []
          : [...TOOL_HOSTS, ...THUMBNAIL_HOSTS, ...COVER_HOSTS, ...LYRICS_HOSTS, ...MODEL_HOSTS],
      }),
      updates: options.updates,
      log: appLogLayer(logger),
      desktop: desktopLayer,
    }),
  );
}
