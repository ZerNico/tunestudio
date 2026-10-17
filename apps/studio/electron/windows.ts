/**
 * One window per project: which window shows which project, and where a project file the OS (or another window) asks
 * to open goes. A project that is open already brings its window to the front; else the file opens in a window showing
 * the start screen, or in a new one. A window's start screen picks up what it is to open (`takeOpenRequest`) when it
 * appears and when told (`OPEN_REQUEST_CHANNEL`).
 */
import fs from "node:fs";

import type { BrowserWindow } from "electron";

import { OPEN_REQUEST_CHANNEL } from "../src/lib/native/channel";

/** A project as a window shows it: its session and its file. */
export interface ShownProject {
  id: string;
  path: string;
}

const real = (path: string) => fs.realpathSync.native(path, { encoding: "utf8" });

/** The same file whatever way its path is written (symlinked folders, `..`). */
function samePath(a: string, b: string): boolean {
  try {
    return real(a) === real(b);
  } catch {
    return a === b;
  }
}

export function createWindows(options: {
  /** Makes a new window (on the start screen). */
  create: () => BrowserWindow;
  /** Lets the renderer read a path it didn't pick itself. */
  grant: (path: string) => Promise<void>;
  /** A window went away with its project: the session can end. */
  onClosed: (project: ShownProject) => void;
  /** Which window shows a project changed. */
  onChange?: () => void;
}) {
  const shown = new Map<BrowserWindow, ShownProject>();
  const requests = new Map<BrowserWindow, string>();
  const windows = new Set<BrowserWindow>();

  const add = () => {
    const window = options.create();
    windows.add(window);
    window.on("closed", () => {
      windows.delete(window);
      requests.delete(window);
      const project = shown.get(window);
      shown.delete(window);
      // Another window may show it too (opened again from its own start screen before this one closed).
      if (project && ![...shown.values()].some((other) => other.id === project.id)) options.onClosed(project);
      options.onChange?.();
    });
    return window;
  };

  return {
    /** A new window on the start screen. */
    add,
    all: () => [...windows].filter((window) => !window.isDestroyed()),
    /** `window` shows `project` now (null: the start screen). */
    show: (window: BrowserWindow, project: ShownProject | null) => {
      if (project) shown.set(window, project);
      else shown.delete(window);
      options.onChange?.();
    },
    /** Whether `window` shows a project. */
    showsProject: (window: BrowserWindow) => shown.has(window),
    /** Whether a window still shows the project session `id`. */
    showsSession: (id: string) => [...shown].some(([window, project]) => !window.isDestroyed() && project.id === id),
    /** The window other than `except` that shows the project at `path`, if there is one. */
    showing: (path: string, except?: BrowserWindow | null): BrowserWindow | null => {
      for (const [window, project] of shown) {
        if (window !== except && !window.isDestroyed() && samePath(project.path, path)) return window;
      }
      return null;
    },
    focus,
    /** Opens a project file the OS handed over: in its window, a start screen's, or a new one. */
    open: async (path: string) => {
      const showing = [...shown].find(([window, project]) => !window.isDestroyed() && samePath(project.path, path));
      if (showing) return focus(showing[0]);
      await options.grant(path);
      const free = [...windows].find((window) => !window.isDestroyed() && !shown.has(window) && !requests.has(window));
      const window = free ?? add();
      requests.set(window, path);
      if (free) window.webContents.send(OPEN_REQUEST_CHANNEL);
      focus(window);
    },
    /** What `window`'s start screen is to open, once. */
    takeOpenRequest: (window: BrowserWindow | null): string | null => {
      if (!window) return null;
      const path = requests.get(window) ?? null;
      requests.delete(window);
      return path;
    },
  };
}

export type Windows = ReturnType<typeof createWindows>;

/** Brings `window` to the front. */
function focus(window: BrowserWindow) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** The project files among a launch's arguments (Windows and Linux hand opened files over as arguments). */
export function projectFilesIn(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg.toLowerCase().endsWith(".tunestudio") && fs.existsSync(arg));
}
