import { Context, type Effect } from "effect";
import type { BrowserWindow } from "electron";

/** What the dialogs ask for. `null` everywhere means the user cancelled. */
interface DesktopShape {
  /** A song folder or `.txt` chart to import. */
  readonly chooseSong: (window: BrowserWindow | null) => Effect.Effect<string | null>;
  /** A `.tunestudio` file to open. */
  readonly chooseProject: (window: BrowserWindow | null) => Effect.Effect<string | null>;
  /** Where to save a new project; `defaultPath` is the suggested file. */
  readonly chooseProjectLocation: (window: BrowserWindow | null, defaultPath: string) => Effect.Effect<string | null>;
  /** A JPEG or PNG image, e.g. for a cover. */
  readonly chooseImage: (window: BrowserWindow | null) => Effect.Effect<string | null>;
  /** Where to save a chart's text (`.txt`); `defaultPath` is the suggested file. */
  readonly chooseTextFile: (window: BrowserWindow | null, defaultPath: string) => Effect.Effect<string | null>;
  /** The folder an export goes into. */
  readonly chooseExportFolder: (window: BrowserWindow | null, defaultPath: string) => Effect.Effect<string | null>;
  /** Shows a file or folder in Finder / Explorer. */
  readonly reveal: (path: string) => Effect.Effect<void>;
  /** A small JPEG thumbnail of an image as a data URL, or null if it can't be read. */
  readonly thumbnail: (image: Uint8Array) => Effect.Effect<string | null>;
  /** The user's country as two letters (e.g. "DE"), for regional catalogs like the iTunes store. */
  readonly country: string;
  /** The user's Music folder. */
  readonly musicFolder: string;
}

/**
 * The desktop shell: native dialogs, the file manager and image scaling. Electron provides it
 * (`desktop-electron.ts`); tests provide their own.
 */
export class Desktop extends Context.Service<Desktop, DesktopShape>()("studio/Desktop") {}
