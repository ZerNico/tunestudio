import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface LaunchOptions {
  /** Load the renderer from this Vite dev server instead of the build on app://. */
  devServerUrl?: string;
  width?: number;
  height?: number;
  /** Allow downloads (yt-dlp, FFmpeg, YouTube), for manual screenshot runs only; tests stay offline. */
  online?: boolean;
  /** Use this data directory and keep it on close (README screenshots seed it with models); a throwaway one otherwise. */
  dataDir?: string;
}

export interface Studio {
  app: ElectronApplication;
  page: Page;
  /** Console errors, warnings and uncaught page errors seen so far. */
  problems: string[];
  close: () => Promise<void>;
}

/**
 * Starts Tune Studio from `dist-electron/` with a throwaway data directory, so it never shares
 * window state or the single-instance lock with a copy you are running.
 */
export async function launchStudio(options: LaunchOptions = {}): Promise<Studio> {
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "tunestudio-e2e-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Terminals inside Electron-based editors export this; it would start plain Node.
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  env.TUNESTUDIO_DATA_DIR = dataDir;
  // The window stays hidden so runs never take focus; TUNESTUDIO_E2E_SHOW=1 shows it for debugging.
  if (!process.env.TUNESTUDIO_E2E_SHOW) env.TUNESTUDIO_BACKGROUND = "1";
  // Never download tools (yt-dlp, FFmpeg) during tests.
  if (options.online) delete env.TUNESTUDIO_OFFLINE;
  else env.TUNESTUDIO_OFFLINE = "1";
  if (options.devServerUrl) env.TUNESTUDIO_DEV_SERVER_URL = options.devServerUrl;
  else delete env.TUNESTUDIO_DEV_SERVER_URL;

  const app = await electron.launch({ args: [appDir], cwd: appDir, env });
  const page = await app.firstWindow();
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

  if (options.width && options.height) await resize({ app, page }, options.width, options.height);
  await page.getByTestId("home").waitFor();
  // Fonts load lazily; screenshots and layout checks need the real metrics.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  return {
    app,
    page,
    problems,
    close: async () => {
      await app.close();
      if (!options.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function resize(studio: Pick<Studio, "app" | "page">, width: number, height: number) {
  await studio.app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
    { width, height },
  );
  await studio.page.waitForFunction((size) => window.innerWidth === size.width, { width, height });
}
