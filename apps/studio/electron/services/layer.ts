import os from "node:os";

import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import { type GamePlatform, gamesLayer } from "../games/games";
import { GameLauncher, gameLauncherLayer } from "../games/launcher";
import { Models, modelsLayer } from "../models/models";
import { Native, nativeLayer } from "../native/native";
import { projectsLayer } from "../project/projects";
import type { Downloads } from "../tools/downloads";
import type { Platform } from "../tools/sources";
import { Tools, toolsLayer } from "../tools/tools";
import type { AppLog } from "./app-log";
import type { Desktop } from "./desktop";
import { draftsLayer } from "./drafts";
import { pathGrantsLayer } from "./path-grants";
import { recentsLayer } from "./recents";
import { settingsLayer } from "./settings";

/** How long a game has to keep running to count as started (one that is open already quits sooner). */

export interface StudioServicesOptions {
  /** Recorded in the project files this app writes. */
  appVersion: string;
  /** Where the recent projects list is stored. */
  recentsFile: string;
  /** Where the app settings are stored. */
  settingsFile: string;
  /** Where new projects are set up before they are saved. */
  draftsFolder: string;
  /** Where a song tried in a game is exported to. */
  tryFolder: string;
  log: Layer.Layer<AppLog>;
  desktop: Layer.Layer<Desktop>;
  /** Where yt-dlp, QuickJS and FFmpeg are installed. */
  toolsFolder: string;
  /** Where the voice separation and listening models are downloaded to. */
  modelsFolder: string;
  /** Where the native addon is (`native/` in development, the app's resources when packaged). */
  nativeFolder: string;
  /** Tests pass a fake engine and models; the app loads the addon and downloads the models. */
  native?: Layer.Layer<Native>;
  models?: Layer.Layer<Models>;
  tools?: Layer.Layer<Tools>;
  platform?: Platform;
  /** Where the games are looked for; this computer's by default. */
  gamePlatform?: GamePlatform;
  /** The app starts games for real; tests record what would have started. */
  launcher?: Layer.Layer<GameLauncher>;
  /** The app downloads for real from the tool hosts; tests from a fake internet, or nowhere. */
  downloads: Layer.Layer<Downloads>;
}

/**
 * Every main-process service. The app passes Electron's log and desktop layers
 * (`runtime.ts`); tests pass their own and get the real projects, recents, settings and file system.
 */
export function studioServices(options: StudioServicesOptions) {
  const { downloads } = options;
  // One settings service for the screen and the games (layers are built once per runtime).
  const settings = settingsLayer(options.settingsFile);
  const own = Layer.mergeAll(
    projectsLayer(options.appVersion),
    recentsLayer(options.recentsFile),
    settings,
    gamesLayer({
      folder: options.tryFolder,
      platform: options.gamePlatform ?? { os: process.platform, home: os.homedir(), env: process.env },
    }).pipe(Layer.provide(Layer.mergeAll(settings, options.launcher ?? gameLauncherLayer))),
    draftsLayer(options.draftsFolder),
    pathGrantsLayer,
    options.tools ??
      toolsLayer({
        folder: options.toolsFolder,
        platform: options.platform ?? { os: process.platform, arch: process.arch },
      }).pipe(Layer.provide(Layer.mergeAll(downloads, options.log))),
    options.models ??
      modelsLayer({ folder: options.modelsFolder }).pipe(Layer.provide(Layer.mergeAll(downloads, options.log))),
    options.native ?? nativeLayer(options.nativeFolder),
  ).pipe(Layer.provide(NodeServices.layer));
  return Layer.mergeAll(own, downloads, options.log, options.desktop, NodeServices.layer);
}

export type StudioServices = Layer.Success<ReturnType<typeof studioServices>>;
