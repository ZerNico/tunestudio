import {
  app,
  type BaseWindow,
  BrowserWindow,
  clipboard,
  Menu,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";

import {
  EDIT_COMMAND_CHANNEL,
  type EditCommand,
  MENU_COMMAND_CHANNEL,
  type MenuCommand,
} from "../src/lib/native/channel";
import { COPYRIGHT } from "./identity";

/**
 * Hands an Edit menu command to the page of the window it is for (the one Electron says, else the focused one); Paste
 * brings the system clipboard's text along.
 */
export async function sendEditCommand(command: EditCommand, window?: BaseWindow) {
  const target = window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow();
  if (!target) return;
  // The developer tools have their own text fields: they get the command as it is.
  if (target.webContents.isDevToolsFocused()) {
    target.webContents.devToolsWebContents?.[command]();
    return;
  }
  // Electron's clipboard is asynchronous (a promise can't be sent to the page).
  const text = command === "paste" ? await clipboard.readText() : undefined;
  target.webContents.send(EDIT_COMMAND_CHANNEL, command, text);
}

/** The File menu's items that act on the project in front (enabled only while one is). */
const PROJECT_ITEMS: { id: MenuCommand; label: string; accelerator?: string }[] = [
  { id: "export-games", label: "Export for Games", accelerator: "CmdOrCtrl+E" },
  { id: "export-usdb", label: "Export for USDB", accelerator: "Shift+CmdOrCtrl+E" },
  { id: "song-details", label: "Song Details", accelerator: "CmdOrCtrl+I" },
  { id: "close-project", label: "Close Project" },
];

/** Hands a File menu command to the page of the window it is for. */
function sendMenuCommand(command: MenuCommand, window?: BaseWindow) {
  const target = window instanceof BrowserWindow ? window : BrowserWindow.getFocusedWindow();
  target?.webContents.send(MENU_COMMAND_CHANNEL, command);
}

/** A project item as the menu shows it: off until a project is in front. */
function projectItem(item: (typeof PROJECT_ITEMS)[number]): MenuItemConstructorOptions {
  return {
    id: item.id,
    label: item.label,
    accelerator: item.accelerator,
    enabled: false,
    click: (_menuItem, window) => sendMenuCommand(item.id, window),
  };
}

/** Enables the File menu's project items while the window in front shows a project (macOS). */
export function setProjectItemsEnabled(enabled: boolean) {
  const menu = Menu.getApplicationMenu();
  for (const item of PROJECT_ITEMS) {
    const entry = menu?.getMenuItemById(item.id);
    if (entry) entry.enabled = enabled;
  }
}

/**
 * On macOS a minimal menu: the app menu; File with New Window (`onNewWindow`, also in the Dock's menu), Open Project
 * (`onOpenProject`), the project's exports, song details and closing it; Edit (which makes copy and paste work in text
 * fields); View with full screen; and Window. Windows and Linux get no menu bar (the page takes Ctrl+Shift+N for a
 * new window, and has the rest on screen). Reload and the developer tools are only there in development.
 */
export function setApplicationMenu(onNewWindow: () => void, onOpenProject: () => void) {
  const development = !app.isPackaged;
  const developmentItems: MenuItemConstructorOptions[] = development
    ? [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }]
    : [];

  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(
      development ? Menu.buildFromTemplate([{ label: "View", submenu: developmentItems.slice(1) }]) : null,
    );
    return;
  }

  app.setAboutPanelOptions({
    applicationName: app.name,
    applicationVersion: app.getVersion(),
    // Otherwise the panel repeats the version as a build number: "0.1.0 (0.1.0)".
    version: "",
    copyright: COPYRIGHT,
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "File",
        submenu: [
          { label: "New Window", accelerator: "Shift+CmdOrCtrl+N", click: () => onNewWindow() },
          { label: "Open Project", accelerator: "CmdOrCtrl+O", click: () => onOpenProject() },
          { type: "separator" },
          ...PROJECT_ITEMS.slice(0, 3).map(projectItem),
          { type: "separator" },
          projectItem(PROJECT_ITEMS[3]!),
          { role: "close" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          // Not the undo/redo roles: those only reach text fields, and Cmd+Z never gets to the page. The page decides.
          { label: "Undo", accelerator: "CmdOrCtrl+Z", click: (_item, window) => void sendEditCommand("undo", window) },
          {
            label: "Redo",
            accelerator: "Shift+CmdOrCtrl+Z",
            click: (_item, window) => void sendEditCommand("redo", window),
          },
          { type: "separator" },
          // Not the roles either: those fire nothing in the page when no text is selected, so the editor's notes
          // couldn't be copied. The page decides, and hands text fields back (`CLIPBOARD_CHANNEL`).
          { label: "Cut", accelerator: "CmdOrCtrl+X", click: (_item, window) => void sendEditCommand("cut", window) },
          { label: "Copy", accelerator: "CmdOrCtrl+C", click: (_item, window) => void sendEditCommand("copy", window) },
          {
            label: "Paste",
            accelerator: "CmdOrCtrl+V",
            click: (_item, window) => void sendEditCommand("paste", window),
          },
          { role: "selectAll" },
        ],
      },
      { label: "View", submenu: [{ role: "togglefullscreen" }, ...developmentItems] },
      { role: "windowMenu" },
    ]),
  );
  app.dock?.setMenu(Menu.buildFromTemplate([{ label: "New Window", click: () => onNewWindow() }]));
}

/**
 * The right-click menu a browser provides. In text fields it offers the
 * edit actions; in development anywhere else it also has back, forward, reload and the
 * inspector. Release builds block right-clicks outside text fields and the app's own menus in the renderer
 * (`screens/root.tsx`), so there it only opens for the edit actions.
 */
export function attachContextMenu(contents: WebContents) {
  contents.on("context-menu", (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];

    if (params.isEditable) {
      items.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
    }

    if (!app.isPackaged) {
      const history = contents.navigationHistory;
      if (items.length > 0) items.push({ type: "separator" });
      items.push(
        { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
        { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
        { label: "Reload", click: () => contents.reload() },
        { type: "separator" },
        { label: "Inspect Element", click: () => contents.inspectElement(params.x, params.y) },
      );
    }

    if (items.length > 0) Menu.buildFromTemplate(items).popup();
  });
}
