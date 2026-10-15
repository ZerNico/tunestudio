import fs from "node:fs";
import path from "node:path";

import { app, BrowserWindow, ipcMain, protocol, session, shell, webContents } from "electron";

import { GRANT_PATH_CHANNEL } from "../src/lib/native/channel";
import { contentSecurityPolicy } from "./csp";
import { onDevReload } from "./dev-reload";
import { BACKGROUND_COLOR, PRODUCT_NAME } from "./identity";
import { createLogger } from "./logger";
import { attachContextMenu, setApplicationMenu } from "./menu";
import { mediaResponse } from "./protocols/media";
import { MEDIA_SCHEME } from "./protocols/media-url";
import { handleRendererProtocol } from "./protocols/renderer";
import { APP_ORIGIN, originOf, registerSchemes } from "./protocols/schemes";
import { createRpcHandler, listenForRpc } from "./rpc";
import { makeRuntime } from "./runtime";
import { PathGrants } from "./services/path-grants";
import { loadWindowState, saveWindowState } from "./window-state";

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

const appUrl = devServerUrl ?? `${APP_ORIGIN}/`;
const appOrigin = devServerUrl ? new URL(devServerUrl).origin : APP_ORIGIN;

const rendererDir = path.join(__dirname, "../dist");

// Electron names the data and log directories after the app, so development builds get
// their own and never share settings, storage or the single-instance lock with a release.
app.setName(app.isPackaged ? PRODUCT_NAME : `${PRODUCT_NAME} Dev`);
// Every renderer is sandboxed, including any created later.
app.enableSandbox();

registerSchemes();

const logger = createLogger(app.getPath("logs"));

// `TUNESTUDIO_DATA_DIR` moves the data directory (and with it the single-instance lock and the
// recent projects) elsewhere, so tests and screenshots never touch, or quit for, a running copy.
if (process.env.TUNESTUDIO_DATA_DIR) app.setPath("userData", process.env.TUNESTUDIO_DATA_DIR);
const dataDir = app.getPath("userData");

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

  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    // First launch; afterwards the saved state replaces these.
    width: 1280,
    height: 820,
    ...saved.bounds,
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
      additionalArguments: [`--ts-version=${app.getVersion()}`],
    },
  });

  if (saved.maximized) window.maximize();
  if (saved.fullscreen) window.setFullScreen(true);
  if (!background) window.once("ready-to-show", () => window.show());
  window.on("close", () => saveWindowState(dataDir, window));

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
  setApplicationMenu();

  // Packaged apps get their icon from the bundle; in development the Dock would show Electron's.
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock?.setIcon(path.join(__dirname, "../resources/icons/icon.png"));
  }

  // The start screen needs no web permissions besides writing the clipboard; everything else
  // is denied, for requests and for the synchronous checks behind `navigator.permissions`.
  const permissions = new Set(["clipboard-sanitized-write"]);
  const allowed = (url: string, permission: string) => originOf(url) === appOrigin && permissions.has(permission);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(allowed(contents.getURL(), permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    allowed(requestingOrigin, permission),
  );

  if (devServerUrl) {
    applyDevelopmentCsp(appOrigin);
    // A new preload only applies to pages loaded after it was built.
    onDevReload(() => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.reloadIgnoringCache();
    });
  } else handleRendererProtocol(rendererDir, contentSecurityPolicy(false));

  protocol.handle(MEDIA_SCHEME, (request) => mediaResponse(request, (effect) => runtime.runPromise(effect)));
  handleGrantedPaths();

  listenForRpc(createRpcHandler(runtime), appOrigin, (id) => {
    const contents = webContents.fromId(id);
    return contents ? BrowserWindow.fromWebContents(contents) : null;
  });

  // Services release what they hold (files, child processes) before the log is flushed.
  app.on("before-quit", () => void runtime.dispose().finally(() => logger.flush()));

  let window = createWindow();
  app.on("second-instance", () => {
    if (window.isDestroyed()) window = createWindow();
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) window = createWindow();
  });
}

process.on("uncaughtException", (error) => logger.write("ERROR", "main", error.stack ?? String(error)));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.whenReady().then(start, (error: unknown) => {
    logger.write("ERROR", "main", `Failed to start: ${error instanceof Error ? error.stack : String(error)}`);
    app.exit(1);
  });
}
