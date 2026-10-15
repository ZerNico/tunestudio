/**
 * IPC channel the preload uses to hand the renderer's MessagePort to the main process.
 * Shared by the client (`client.ts`), the preload and the main process (`electron/rpc`).
 */
export const RPC_CONNECT_CHANNEL = "tunestudio:connect-rpc";

/** The same for the Effect RPC connection (`rpcs.ts`), while calls move over from oRPC. */
export const EFFECT_RPC_CONNECT_CHANNEL = "tunestudio:connect-effect-rpc";

/**
 * IPC channel the preload uses to report the path of a dropped or picked file, so main lets the
 * renderer use it (see `pathForFile` in `electron/preload.ts`).
 */
export const GRANT_PATH_CHANNEL = "tunestudio:grant-path";

/**
 * IPC channel the Edit menu's Undo and Redo use (macOS): the page decides whether they undo text in a field or an
 * edit in the editor (see `src/lib/edit-commands.ts`).
 */
export const EDIT_COMMAND_CHANNEL = "tunestudio:edit-command";

/** What the Edit menu asks the page to do. */
export type EditCommand = "undo" | "redo";
