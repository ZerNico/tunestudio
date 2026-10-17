import { ipcMain, type WebContents } from "electron";

import { FLUSH_CHANNEL, FLUSH_DONE_CHANNEL } from "./flush-channel";

/** How long a page gets to save before its window closes anyway. */
export const FLUSH_TIMEOUT_MS = 3000;

let nextRequest = 0;

/**
 * Asks the page in `contents` to save what is still waiting (the editor's edits) and resolves once it says it has, or
 * after `timeoutMs`, or when the page goes away. Never rejects.
 */
export function flushPage(contents: WebContents, timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
  if (contents.isDestroyed() || contents.isCrashed()) return Promise.resolve();
  const request = ++nextRequest;
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      ipcMain.removeListener(FLUSH_DONE_CHANNEL, answered);
      contents.removeListener("destroyed", done);
      contents.removeListener("render-process-gone", done);
      resolve();
    };
    const answered = (event: Electron.IpcMainEvent, id: unknown) => {
      if (event.sender === contents && id === request) done();
    };
    const timer = setTimeout(done, timeoutMs);
    ipcMain.on(FLUSH_DONE_CHANNEL, answered);
    contents.once("destroyed", done);
    contents.once("render-process-gone", done);
    contents.send(FLUSH_CHANNEL, request);
  });
}

/** Saves what the page is waiting to save, then reloads it. */
export function flushThenReload(contents: WebContents, ignoringCache = false) {
  void flushPage(contents).then(() => {
    if (contents.isDestroyed()) return;
    if (ignoringCache) contents.reloadIgnoringCache();
    else contents.reload();
  });
}
