import { contextBridge, ipcRenderer, webUtils } from "electron";

import {
  EDIT_COMMAND_CHANNEL,
  EFFECT_RPC_CONNECT_CHANNEL,
  type EditCommand,
  GRANT_PATH_CHANNEL,
  RPC_CONNECT_CHANNEL,
} from "../src/lib/native/channel";

// The renderer opens the RPC connection by posting one end of a MessageChannel to itself.
// MessagePorts can't cross `contextBridge`, so the preload picks the port up from the
// window message and hands it to the main process. Only messages the page posts to its own
// window count.
window.addEventListener("message", (event) => {
  if (event.source !== window || (event.data !== RPC_CONNECT_CHANNEL && event.data !== EFFECT_RPC_CONNECT_CHANNEL))
    return;
  const [port] = event.ports;
  if (port) ipcRenderer.postMessage(event.data, null, [port]);
});

function argument(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? "";
}

/** Values the renderer needs synchronously. Everything else goes through the RPC contract. */
contextBridge.exposeInMainWorld("tunestudio", {
  platform: process.platform,
  version: argument("ts-version"),
  /**
   * The path of a dropped or picked file or folder, and whether it is a folder; main then lets
   * the renderer use that path. `null` for files that aren't on disk.
   */
  pathForFile: (file: File): Promise<{ path: string; kind: "file" | "directory" } | null> => {
    const path = webUtils.getPathForFile(file);
    return path ? ipcRenderer.invoke(GRANT_PATH_CHANNEL, path) : Promise.resolve(null);
  },
  /** Calls `listener` with the Edit menu's Undo and Redo; returns a function that stops it. */
  onEditCommand: (listener: (command: EditCommand) => void): (() => void) => {
    const forward = (_event: unknown, command: EditCommand) => listener(command);
    ipcRenderer.on(EDIT_COMMAND_CHANNEL, forward);
    return () => ipcRenderer.removeListener(EDIT_COMMAND_CHANNEL, forward);
  },
});
