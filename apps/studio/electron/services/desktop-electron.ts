import fs from "node:fs";
import path from "node:path";

import { Effect, Layer } from "effect";
import {
  app,
  type BrowserWindow,
  dialog,
  type MessageBoxOptions,
  nativeImage,
  type OpenDialogOptions,
  type SaveDialogOptions,
  shell,
} from "electron";

import { FileNotFound, FileSystemFailure } from "../../src/lib/errors";
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from "../../src/lib/import-files";
import { chromiumLicensesFile } from "../chromium-licenses";
import { Desktop } from "./desktop";

/** Runs a dialog attached to `window` (a sheet on macOS) when there is one. */
function openDialog(window: BrowserWindow | null, options: OpenDialogOptions) {
  return Effect.promise(async () => {
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}

/**
 * A save dialog whose answer always ends in `.<extension>`. Linux's dialog neither adds it nor asks before replacing
 * the file the name then has, so that is asked here, and "no" shows the dialog again.
 */
function saveDialog(window: BrowserWindow | null, options: SaveDialogOptions, extension: string) {
  return Effect.promise(async () => {
    let defaultPath = options.defaultPath;
    for (;;) {
      const asked = { ...options, defaultPath };
      const result = window ? await dialog.showSaveDialog(window, asked) : await dialog.showSaveDialog(asked);
      if (result.canceled || !result.filePath) return null;
      if (result.filePath.toLowerCase().endsWith(`.${extension}`)) return result.filePath;
      const named = `${result.filePath}.${extension}`;
      if (!fs.existsSync(named)) return named;
      const box: MessageBoxOptions = {
        type: "warning",
        message: `“${path.basename(named)}” already exists. Replace it?`,
        detail: "Replacing it overwrites what is in it.",
        buttons: ["Replace", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      };
      const answer = window ? await dialog.showMessageBox(window, box) : await dialog.showMessageBox(box);
      if (answer.response === 0) return named;
      defaultPath = named;
    }
  });
}

/** Electron's dialogs, shell and image scaling. */
export const desktopLayer = Layer.sync(Desktop, () => ({
  // macOS can pick a file or a folder in one dialog; Windows and Linux show a folder picker for
  // this combination, and a chart file can be dropped on the window instead.
  chooseSong: (window) =>
    openDialog(window, {
      title: "Import an UltraStar song",
      buttonLabel: "Import",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "UltraStar chart", extensions: ["txt"] }],
    }),
  chooseProject: (window) =>
    openDialog(window, {
      title: "Open project",
      buttonLabel: "Open",
      properties: ["openFile"],
      filters: [{ name: "Tune Studio project", extensions: ["tunestudio"] }],
    }),
  chooseProjectLocation: (window, defaultPath) =>
    saveDialog(
      window,
      {
        title: "Save the new project",
        buttonLabel: "Create project",
        defaultPath,
        filters: [{ name: "Tune Studio project", extensions: ["tunestudio"] }],
      },
      "tunestudio",
    ),
  // UltraStar games read JPEG and PNG covers; not every one reads WebP.
  chooseImage: (window) =>
    openDialog(window, {
      title: "Choose a cover",
      buttonLabel: "Use as cover",
      properties: ["openFile"],
      filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png"] }],
    }),
  chooseMediaFile: (window, kind) =>
    openDialog(window, {
      title: kind === "audio" ? "Choose an audio file" : "Choose a video",
      buttonLabel: "Use this file",
      properties: ["openFile"],
      filters: [
        kind === "audio"
          ? { name: "Audio", extensions: [...AUDIO_EXTENSIONS] }
          : { name: "Video", extensions: [...VIDEO_EXTENSIONS] },
      ],
    }),
  chooseTextFile: (window, defaultPath) =>
    saveDialog(
      window,
      {
        title: "Export for USDB",
        buttonLabel: "Export",
        defaultPath,
        filters: [{ name: "UltraStar chart", extensions: ["txt"] }],
      },
      "txt",
    ),
  chooseExportFolder: (window, defaultPath) =>
    openDialog(window, {
      title: "Export UltraStar song",
      buttonLabel: "Export here",
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
    }),
  reveal: (path) => Effect.sync(() => shell.showItemInFolder(path)),
  openChromiumLicenses: Effect.suspend((): Effect.Effect<void, FileNotFound | FileSystemFailure> => {
    const file = chromiumLicensesFile({ execPath: process.execPath, resourcesPath: process.resourcesPath });
    if (!file) return Effect.fail(new FileNotFound({ message: "Chromium's licenses aren't in the app's folder." }));
    return Effect.flatMap(
      Effect.promise(() => shell.openPath(file)),
      (problem) =>
        problem
          ? Effect.fail(new FileSystemFailure({ message: `Couldn't open Chromium's licenses. ${problem}` }))
          : Effect.void,
    );
  }),
  thumbnail: (image) =>
    Effect.sync(() => {
      const picture = nativeImage.createFromBuffer(Buffer.from(image));
      if (picture.isEmpty()) return null;
      const { width, height } = picture.getSize();
      const scaled = width > height ? picture.resize({ height: 192 }) : picture.resize({ width: 192 });
      return `data:image/jpeg;base64,${scaled.toJPEG(82).toString("base64")}`;
    }),
  country: app.getLocaleCountryCode() || "US",
  musicFolder: app.getPath("music"),
}));
