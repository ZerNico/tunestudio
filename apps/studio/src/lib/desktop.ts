import type { ClipboardRequest, EditCommand } from "./native/channel";

/** A dropped or picked file's place on disk. */
export interface FilePath {
  path: string;
  kind: "file" | "directory";
}

/** Values and helpers the preload provides (see `electron/preload.ts`). */
interface DesktopGlobals {
  platform: string;
  version: string;
  pathForFile?: (file: File) => Promise<FilePath | null>;
  onEditCommand?: (listener: (command: EditCommand, text?: string) => void) => () => void;
  clipboard?: (request: ClipboardRequest) => void;
}

declare global {
  interface Window {
    tunestudio?: DesktopGlobals;
  }
}

// Missing when the renderer runs in a plain browser (`bun run dev:vite`).
const globals: DesktopGlobals = window.tunestudio ?? { platform: "browser", version: "0.0.0-dev" };

export type Platform = "macos" | "windows" | "linux" | "browser";

export const platform: Platform =
  globals.platform === "darwin"
    ? "macos"
    : globals.platform === "win32"
      ? "windows"
      : globals.platform === "linux"
        ? "linux"
        : "browser";

export const appVersion: string = globals.version;

/** "Reveal in Finder" on macOS, "Show in Explorer" on Windows, "Show in folder" elsewhere. */
export const revealLabel =
  platform === "macos" ? "Reveal in Finder" : platform === "windows" ? "Show in Explorer" : "Show in folder";

/**
 * Where a dropped or picked `File` is on disk; main then lets the renderer use that path.
 * `null` in a plain browser and for files that aren't on disk.
 */
export function pathForFile(file: File): Promise<FilePath | null> {
  return globals.pathForFile?.(file) ?? Promise.resolve(null);
}
