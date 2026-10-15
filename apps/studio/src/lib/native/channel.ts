/**
 * IPC channel the preload uses to hand the renderer's MessagePort to the main process.
 * Shared by the client (`client.ts`), the preload and the main process (`electron/rpc`).
 */
export const RPC_CONNECT_CHANNEL = "tunestudio:connect-rpc";

/**
 * IPC channel the preload uses to report the path of a dropped or picked file, so main lets the
 * renderer use it (see `pathForFile` in `electron/preload.ts`).
 */
export const GRANT_PATH_CHANNEL = "tunestudio:grant-path";
