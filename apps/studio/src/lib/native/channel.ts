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

/**
 * IPC channel the Edit menu's Undo and Redo use (macOS): the page decides whether they undo text in a field or an
 * edit in the editor (see `src/lib/edit-commands.ts`).
 */
export const EDIT_COMMAND_CHANNEL = "tunestudio:edit-command";

/** What the Edit menu asks the page to do. */
export type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste";

/**
 * IPC channel the page answers the Edit menu's Cut, Copy and Paste on: text for the system clipboard (it copied notes),
 * or "do it natively" (a text field has them; main runs the web contents' own cut, copy or paste). The page's own
 * Paste (the note menu) asks on it too: main sends Paste back with the clipboard's text, as the Edit menu does.
 */
export const CLIPBOARD_CHANNEL = "tunestudio:clipboard";

export type ClipboardRequest = { write: string } | { native: "cut" | "copy" | "paste" } | { send: "paste" };

/**
 * IPC channel main nudges a window's start screen on when it has a project file to open (one the OS handed over); the
 * page then asks for it (`windows.takeOpenRequest`).
 */
export const OPEN_REQUEST_CHANNEL = "tunestudio:open-request";

/**
 * IPC channel the File menu (macOS) sends a project window's commands on: exports, trying the song in a game, song
 * details, closing it.
 */
export const MENU_COMMAND_CHANNEL = "tunestudio:menu-command";

/** What the File menu asks a project window to do. */
export type MenuCommand = "export-games" | "export-usdb" | "try-in-game" | "song-details" | "close-project";
