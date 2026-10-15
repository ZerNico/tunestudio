import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import { Models, modelsLayer } from "../models/models";
import { Native, nativeLayer } from "../native/native";
import { projectsLayer } from "../project/projects";
import {
  COVER_HOSTS,
  Downloads,
  downloadsLayer,
  LYRICS_HOSTS,
  MODEL_HOSTS,
  THUMBNAIL_HOSTS,
  TOOL_HOSTS,
} from "../tools/downloads";
import type { Platform } from "../tools/sources";
import { toolsLayer } from "../tools/tools";
import type { AppLog } from "./app-log";
import type { Desktop } from "./desktop";
import { draftsLayer } from "./drafts";
import { pathGrantsLayer } from "./path-grants";
import { recentsLayer } from "./recents";
import { settingsLayer } from "./settings";

export interface StudioServicesOptions {
  /** Recorded in the project files this app writes. */
  appVersion: string;
  /** Where the recent projects list is stored. */
  recentsFile: string;
  /** Where the app settings are stored. */
  settingsFile: string;
  /** Where new projects are set up before they are saved. */
  draftsFolder: string;
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
  platform?: Platform;
  /** Tests pass a fake internet; the app downloads for real from the tool hosts. */
  downloads?: Layer.Layer<Downloads>;
}

/**
 * Every main-process service. The app passes Electron's log and desktop layers
 * (`runtime.ts`); tests pass their own and get the real projects, recents, settings and file system.
 */
export function studioServices(options: StudioServicesOptions) {
  const downloads =
    options.downloads ??
    downloadsLayer({ hosts: [...TOOL_HOSTS, ...THUMBNAIL_HOSTS, ...COVER_HOSTS, ...LYRICS_HOSTS, ...MODEL_HOSTS] });
  const own = Layer.mergeAll(
    projectsLayer(options.appVersion),
    recentsLayer(options.recentsFile),
    settingsLayer(options.settingsFile),
    draftsLayer(options.draftsFolder),
    pathGrantsLayer,
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
