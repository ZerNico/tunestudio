import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, type WebContents } from "electron";

import { EDIT_COMMAND_CHANNEL, type EditCommand } from "../src/lib/native/channel";
import { COPYRIGHT } from "./identity";

/** Hands Undo or Redo to the focused window's page. */
function sendEditCommand(command: EditCommand) {
  BrowserWindow.getFocusedWindow()?.webContents.send(EDIT_COMMAND_CHANNEL, command);
}

/**
 * On macOS a minimal menu: the app menu, Edit (which makes copy and paste work in text
 * fields), View with full screen, and Window. Windows and Linux get no menu bar. Reload
 * and the developer tools are only there in development.
 */
export function setApplicationMenu() {
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
        label: "Edit",
        submenu: [
          // Not the undo/redo roles: those only reach text fields, and Cmd+Z never gets to the page. The page decides.
          { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => sendEditCommand("undo") },
          { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: () => sendEditCommand("redo") },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      { label: "View", submenu: [{ role: "togglefullscreen" }, ...developmentItems] },
      { role: "windowMenu" },
    ]),
  );
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
