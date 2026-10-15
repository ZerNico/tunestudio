/**
 * Dev-only signal from `scripts/dev.ts` over the IPC channel it opens to Electron: the preload
 * changed but the main process didn't, so reloading the windows is enough.
 */
export const DEV_RELOAD_MESSAGE = "tunestudio:reload-windows";

/** Calls `reload` whenever the dev script asks for it. Without the dev script there's no channel. */
export function onDevReload(reload: () => void) {
  if (!process.send) return;
  process.on("message", (message) => {
    if (message === DEV_RELOAD_MESSAGE) reload();
  });
}
