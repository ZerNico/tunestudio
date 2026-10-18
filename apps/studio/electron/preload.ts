import { contextBridge, ipcRenderer, webUtils } from "electron";

import {
  CLIPBOARD_CHANNEL,
  type ClipboardRequest,
  EDIT_COMMAND_CHANNEL,
  type EditCommand,
  GRANT_PATH_CHANNEL,
  MENU_COMMAND_CHANNEL,
  type MenuCommand,
  OPEN_REQUEST_CHANNEL,
  RPC_CONNECT_CHANNEL,
} from "../src/lib/native/channel";
import { FLUSH_CHANNEL, FLUSH_DONE_CHANNEL } from "./flush-channel";
import { VERSION_ARGUMENT } from "./identity";

// The renderer opens the RPC connection by posting one end of a MessageChannel to itself.
// MessagePorts can't cross `contextBridge`, so the preload picks the port up from the
// window message and hands it to the main process. Only messages the page posts to its own
// window count.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data !== RPC_CONNECT_CHANNEL) return;
  const [port] = event.ports;
  if (port) ipcRenderer.postMessage(RPC_CONNECT_CHANNEL, null, [port]);
});

// Main asks the page to save what is still waiting before its window closes, the app quits or the page reloads; the
// page's handler (`src/lib/flush.ts`) says how. The answer goes back however that went: main only waits for it.
let flushHandler: (() => Promise<void>) | null = null;
ipcRenderer.on(FLUSH_CHANNEL, (_event, request: number) => {
  const handler = flushHandler;
  void Promise.resolve()
    .then(() => handler?.())
    .catch(() => {})
    .finally(() => ipcRenderer.send(FLUSH_DONE_CHANNEL, request));
});

/** Values the renderer needs synchronously. Everything else goes through the RPC contract. */
contextBridge.exposeInMainWorld("tunestudio", {
  platform: process.platform,
  /** The app's version, which main passes in the arguments. */
  version: process.argv.find((argument) => argument.startsWith(VERSION_ARGUMENT))?.slice(VERSION_ARGUMENT.length),
  /** The version of Chromium inside Electron. */
  chromeVersion: process.versions.chrome,
  /**
   * The path of a dropped or picked file or folder, and whether it is a folder; main then lets
   * the renderer use that path. `null` for files that aren't on disk.
   */
  pathForFile: (file: File): Promise<{ path: string; kind: "file" | "directory" } | null> => {
    const path = webUtils.getPathForFile(file);
    return path ? ipcRenderer.invoke(GRANT_PATH_CHANNEL, path) : Promise.resolve(null);
  },
  /** Calls `listener` with the Edit menu's Undo and Redo; returns a function that stops it. */
  onEditCommand: (listener: (command: EditCommand, text?: string) => void): (() => void) => {
    const forward = (_event: unknown, command: EditCommand, text?: string) => listener(command, text);
    ipcRenderer.on(EDIT_COMMAND_CHANNEL, forward);
    return () => ipcRenderer.removeListener(EDIT_COMMAND_CHANNEL, forward);
  },
  /** Calls `listener` with the File menu's commands for this window; returns a function that stops it. */
  onMenuCommand: (listener: (command: MenuCommand) => void): (() => void) => {
    const forward = (_event: unknown, command: MenuCommand) => listener(command);
    ipcRenderer.on(MENU_COMMAND_CHANNEL, forward);
    return () => ipcRenderer.removeListener(MENU_COMMAND_CHANNEL, forward);
  },
  /** Calls `listener` when main has a project file for this window to open; returns a function that stops it. */
  onOpenRequest: (listener: () => void): (() => void) => {
    const forward = () => listener();
    ipcRenderer.on(OPEN_REQUEST_CHANNEL, forward);
    return () => ipcRenderer.removeListener(OPEN_REQUEST_CHANNEL, forward);
  },
  /**
   * Makes `handler` save what is still waiting when main asks (only the latest one is asked); returns a function that
   * stops it.
   */
  onFlushRequest: (handler: () => Promise<void>): (() => void) => {
    flushHandler = handler;
    return () => {
      if (flushHandler === handler) flushHandler = null;
    };
  },
  /** Answers Cut, Copy or Paste from the Edit menu: text for the system clipboard, or "do it natively". */
  clipboard: (request: ClipboardRequest) => ipcRenderer.send(CLIPBOARD_CHANNEL, request),
});
