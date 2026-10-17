import fs from "node:fs";
import path from "node:path";

import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  protocol,
  session,
  shell,
  systemPreferences,
  webContents,
} from "electron";

import { CLIPBOARD_CHANNEL, GRANT_PATH_CHANNEL } from "../src/lib/native/channel";
import { contentSecurityPolicy } from "./csp";
import { onDevReload } from "./dev-reload";
import { flushPage, flushThenReload } from "./flush";
import { BACKGROUND_COLOR, PRODUCT_NAME } from "./identity";
import { createLogger } from "./logger";
import { attachContextMenu, sendEditCommand, setApplicationMenu, setProjectItemsEnabled } from "./menu";
import { allowsPermission } from "./permissions";
import { Projects } from "./project/projects";
import { mediaResponse } from "./protocols/media";
import { MEDIA_SCHEME } from "./protocols/media-url";
import { handleRendererProtocol } from "./protocols/renderer";
import { APP_ORIGIN, originOf, registerSchemes } from "./protocols/schemes";
import { listenForRpc } from "./rpc";
import { nativeHandlers } from "./rpc/procedures";
import { startRpcServer } from "./rpc/server";
import { makeRuntime } from "./runtime";
import { Desktop } from "./services/desktop";
import { PathGrants } from "./services/path-grants";
import { loadWindowState, saveWindowState } from "./window-state";
import { createWindows, projectFilesIn, type Windows } from "./windows";

/** Set by the dev script; packaged and preview builds load the bundled frontend instead. */
const devServerUrl = process.env.TUNESTUDIO_DEV_SERVER_URL;
if (devServerUrl && !/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(devServerUrl)) {
  throw new Error("TUNESTUDIO_DEV_SERVER_URL must be a loopback origin");
}

/**
 * Tests and screenshot runs set this so the app works without ever showing a window or taking
 * focus from whatever you are doing; the pages still render and can be captured.
 */
const background = process.env.TUNESTUDIO_BACKGROUND === "1";

/** How long quitting waits for the services to release what they hold. */
const QUIT_TIMEOUT_MS = 5000;

const appUrl = devServerUrl ?? `${APP_ORIGIN}/`;
const appOrigin = devServerUrl ? new URL(devServerUrl).origin : APP_ORIGIN;

const rendererDir = path.join(__dirname, "../dist");

// Electron names the data and log directories after the app, so development builds get
// their own and never share settings, storage or the single-instance lock with a release.
app.setName(app.isPackaged ? PRODUCT_NAME : `${PRODUCT_NAME} Dev`);
// Every renderer is sandboxed, including any created later.
app.enableSandbox();

registerSchemes();

// `TUNESTUDIO_DATA_DIR` moves the data directory (and with it the single-instance lock, the
// recent projects and the log) elsewhere, so tests and screenshots never touch, or quit for, a
// running copy.
if (process.env.TUNESTUDIO_DATA_DIR) {
  app.setPath("userData", process.env.TUNESTUDIO_DATA_DIR);
  app.setAppLogsPath(path.join(process.env.TUNESTUDIO_DATA_DIR, "logs"));
}
const dataDir = app.getPath("userData");

const logger = createLogger(app.getPath("logs"));

// `TUNESTUDIO_OFFLINE` keeps tests from downloading yt-dlp and FFmpeg.
const runtime = makeRuntime(logger, {
  dataDir,
  appVersion: app.getVersion(),
  // Packaged, the addon sits in the app's resources, outside the archive.
  nativeFolder: app.isPackaged ? path.join(process.resourcesPath, "native") : path.join(app.getAppPath(), "native"),
  offline: process.env.TUNESTUDIO_OFFLINE === "1",
});

/** Whether an IPC message comes from the top-level frame of one of the app's own pages. */
function fromAppFrame(frame: Electron.WebFrameMain | null) {
  return Boolean(frame && !frame.parent && originOf(frame.url) === appOrigin);
}

/**
 * The preload asks for this when a file or folder is dropped (or picked with a file input): it
 * hands over the path Electron knows for the real `File`, which the renderer can't make up.
 * Granting it lets the renderer pass the path to the RPC procedures.
 */
function handleGrantedPaths() {
  ipcMain.handle(GRANT_PATH_CHANNEL, async (event, value: unknown) => {
    if (!fromAppFrame(event.senderFrame) || typeof value !== "string" || !value) return null;
    const stats = fs.statSync(value, { throwIfNoEntry: false });
    if (!stats) return null;
    await runtime.runPromise(PathGrants.use((grants) => grants.grant(value)));
    return { path: value, kind: stats.isDirectory() ? "directory" : "file" };
  });
}

/**
 * The page's answer to the Edit menu's Cut, Copy and Paste: text it copied for the system clipboard, or a text field's
 * turn, done with the web contents' own cut, copy or paste.
 */
function handleClipboard() {
  ipcMain.on(CLIPBOARD_CHANNEL, (event, request: unknown) => {
    if (!fromAppFrame(event.senderFrame) || typeof request !== "object" || request === null) return;
    if ("write" in request && typeof request.write === "string") void clipboard.writeText(request.write);
    else if (
      "native" in request &&
      (request.native === "cut" || request.native === "copy" || request.native === "paste")
    )
      event.sender[request.native]();
    else if ("send" in request && request.send === "paste") {
      // Back to the page that asked (never another window).
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) void sendEditCommand("paste", window);
    }
  });
}

/** Applies the same CSP to pages from the Vite dev server, so problems show up in development. */
function applyDevelopmentCsp(origin: string) {
  const policy = contentSecurityPolicy(true);
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    if (details.resourceType !== "mainFrame") return callback({});
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] } });
  });
}

function createWindow(): BrowserWindow {
  const saved = loadWindowState(dataDir);
  const mac = process.platform === "darwin";
  // Another window opens a little below and to the right of the one in front.
  const front = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(-1);
  const bounds = front ? { ...front.getContentBounds() } : saved.bounds;
  if (front && bounds) Object.assign(bounds, { x: bounds.x + 28, y: bounds.y + 28 });

  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    // First launch; afterwards the saved state replaces these.
    width: 1280,
    height: 820,
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    useContentSize: true,
    backgroundColor: BACKGROUND_COLOR,
    show: false,
    // A pro-app frame: on macOS the traffic lights sit inside the app's own title bar; on
    // Windows and Linux the native caption buttons are drawn over it.
    titleBarStyle: "hidden",
    ...(mac
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarOverlay: { color: BACKGROUND_COLOR, symbolColor: "#a1aaa8", height: 44 } }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });

  if (!front && saved.maximized) window.maximize();
  if (!front && saved.fullscreen) window.setFullScreen(true);
  if (!background) window.once("ready-to-show", () => window.show());
  // Closing waits for the page to save what is still waiting (a few seconds at most), then closes for real. Quitting
  // has asked every page already.
  let flushed = false;
  let flushing = false;
  window.on("close", (event) => {
    if (flushed || quitting) return saveWindowState(dataDir, window);
    event.preventDefault();
    if (flushing) return;
    flushing = true;
    void flushPage(window.webContents).then(() => {
      flushed = true;
      if (!window.isDestroyed()) window.close();
    });
  });

  attachContextMenu(window.webContents);

  // No pinch zoom: the editor will use pinch and scroll gestures itself.
  void window.webContents.setVisualZoomLevelLimits(1, 1);

  // Links to other sites open in the browser; the app never opens windows of its own from the page.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The window never navigates away from the app, e.g. when a file is dropped outside a drop zone.
  window.webContents.on("will-navigate", (event, url) => {
    if (originOf(url) !== appOrigin) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());

  void window.loadURL(appUrl);
  return window;
}

function start() {
  // No Dock icon and no activation: a background run never steals focus on macOS.
  if (background && process.platform === "darwin") app.setActivationPolicy("accessory");
  setApplicationMenu(
    () => windows?.add(),
    () => {
      const front = BrowserWindow.getFocusedWindow();
      void runtime.runPromise(Desktop.use((desktop) => desktop.chooseProject(front))).then((file) => {
        if (file) void windows?.open(file);
      });
    },
  );

  // Packaged apps get their icon from the bundle; in development the Dock would show Electron's.
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock?.setIcon(path.join(__dirname, "../resources/icons/icon.png"));
  }

  // Only what `allowsPermission` lets the app's pages have. The microphone also needs macOS's consent, asked first so
  // its prompt shows (a refusal there is remembered in System Settings).
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    // The frame asking, not the page it is in; the microphone only for the page itself.
    const mediaTypes = "mediaTypes" in details && details.isMainFrame ? (details.mediaTypes ?? []) : [];
    if (!allowsPermission(originOf(details.requestingUrl), appOrigin, permission, mediaTypes)) return callback(false);
    if (permission !== "media" || process.platform !== "darwin") return callback(true);
    systemPreferences.askForMediaAccess("microphone").then(callback, () => callback(false));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    allowsPermission(originOf(requestingOrigin), appOrigin, permission, details.mediaType ? [details.mediaType] : []),
  );

  if (devServerUrl) {
    applyDevelopmentCsp(appOrigin);
    // A new preload only applies to pages loaded after it was built.
    onDevReload(() => {
      for (const window of BrowserWindow.getAllWindows()) flushThenReload(window.webContents, true);
    });
  } else handleRendererProtocol(rendererDir, contentSecurityPolicy(false));

  protocol.handle(MEDIA_SCHEME, (request) => mediaResponse(request, (effect) => runtime.runPromise(effect)));
  handleGrantedPaths();
  handleClipboard();

  windows = createWindows({
    create: createWindow,
    grant: (file) => runtime.runPromise(PathGrants.use((grants) => grants.grant(file))),
    // A project's window closed without closing it first: its session ends with it.
    onClosed: (project) => void runtime.runPromise(Projects.use((projects) => projects.close(project.id))),
    onChange: () => updateProjectItems(),
  });
  const opened = windows;
  // The File menu's project items follow the window in front.
  const updateProjectItems = () => {
    const front = BrowserWindow.getFocusedWindow();
    setProjectItemsEnabled(front !== null && opened.showsProject(front));
  };
  app.on("browser-window-focus", () => updateProjectItems());
  listenForRpc(startRpcServer(runtime, nativeHandlers, opened), appOrigin, (id) => {
    const contents = webContents.fromId(id);
    return contents ? BrowserWindow.fromWebContents(contents) : null;
  });

  // Quitting lets every page save what is waiting, then waits while services release what they hold (projects, child
  // processes) and the log is flushed, a few seconds each at most. The windows are hidden first, so nothing more is
  // edited.
  let released = false;
  app.on("before-quit", (event) => {
    if (released) return;
    event.preventDefault();
    released = true;
    const open = BrowserWindow.getAllWindows();
    for (const window of open) window.hide();
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS));
    void Promise.all(open.map((window) => flushPage(window.webContents)))
      .then(() => {
        quitting = true;
        return Promise.race([runtime.dispose(), timeout]);
      })
      .catch((error: unknown) => logger.write("ERROR", "main", `Quitting: ${String(error)}`))
      .finally(() => logger.flush().finally(() => app.quit()));
  });

  // Project files the OS handed over before the app was ready open now; without any, the start screen.
  const files = pendingFiles.splice(0);
  if (files.length === 0) opened.add();
  for (const file of files) void opened.open(file);
  // Starting Tune Studio again (or opening a project file on Windows and Linux) comes to this one.
  app.on("second-instance", (_event, argv) => {
    const asked = projectFilesIn(argv.slice(1));
    for (const file of asked) void opened.open(file);
    if (asked.length > 0) return;
    const front = BrowserWindow.getFocusedWindow() ?? opened.all().at(-1);
    if (front) opened.focus(front);
    else opened.add();
  });
  app.on("activate", () => {
    if (opened.all().length === 0) opened.add();
  });
}

/** Which window shows which project, once the app is ready. */
let windows: Windows | null = null;
/** Set once quitting has let every page save: windows then close without asking again. */
let quitting = false;
/** Project files to open once the app is ready: from the command line, or from the OS before it was. */
const pendingFiles = projectFilesIn(process.argv.slice(1));

process.on("uncaughtException", (error) => logger.write("ERROR", "main", error.stack ?? String(error)));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // macOS hands over project files (double-clicked, dropped on the Dock icon) as events, also before the app is ready.
  app.on("open-file", (event, file) => {
    event.preventDefault();
    if (windows) void windows.open(file);
    else pendingFiles.push(file);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.whenReady().then(start, (error: unknown) => {
    logger.write("ERROR", "main", `Failed to start: ${error instanceof Error ? error.stack : String(error)}`);
    app.exit(1);
  });
}
