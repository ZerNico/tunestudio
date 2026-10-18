import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";
import * as esbuild from "esbuild";

import { DEV_RELOAD_MESSAGE } from "../electron/dev-reload";
import { electronBuildOptions } from "./build-electron";
import { DEV_SERVER_PORT } from "./dev-port";

/**
 * Development loop: starts Vite, bundles the main process and preload in watch mode, restarts
 * Electron when the main process changed and only reloads its windows when just the preload
 * did. Renderer changes hot-reload through Vite. Arguments are passed on to the app. The native
 * addon is built first (cargo's own check makes that quick when nothing changed).
 */
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const SERVER_TIMEOUT_MS = 30_000;
const appArgs = process.argv.slice(2);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist-electron");

let electron: ChildProcess | undefined;
let restarting = false;
let shuttingDown = false;
let context: esbuild.BuildContext | undefined;

function shutdown(code: number, reason?: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.error(`\n[dev] ${reason}`);
  void context?.dispose();
  if (vite.exitCode === null) vite.kill();
  if (electron?.exitCode === null) electron.kill();
  process.exit(code);
}

const native = spawnSync("bun", ["run", "native:build"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (native.status !== 0) {
  console.error("\n[dev] Building the native addon failed, not starting the app.");
  process.exit(native.status || 1);
}

// Vite's own binary, not `bun run dev:vite`: killing a package-manager wrapper can leave
// the server behind.
const vite = spawn(path.join(root, "node_modules/.bin/vite"), {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
vite.on("exit", (code, signal) => {
  shutdown(code || 1, `Vite exited (${signal ?? `code ${code}`}), stopping the dev loop.`);
});

async function waitForServer(url: string) {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  shutdown(1, `Vite didn't answer on ${url} within ${SERVER_TIMEOUT_MS / 1000} s. Is port ${DEV_SERVER_PORT} free?`);
}

await waitForServer(DEV_SERVER_URL);

function startElectron() {
  // Terminals inside Electron-based editors can leak this, which would start Electron as
  // plain Node instead of the app.
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  electron = spawn(String(electronPath), [".", ...appArgs], {
    cwd: root,
    // The IPC channel carries preload reloads (`electron/dev-reload.ts`).
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: { ...env, TUNESTUDIO_DEV_SERVER_URL: DEV_SERVER_URL },
  });
  electron.on("exit", (code) => {
    if (!restarting) shutdown(code ?? 0);
  });
}

function restartElectron() {
  // A restart already waits for the old app to quit; the Electron it starts loads the newest bundle.
  if (restarting) return;
  if (!electron || electron.exitCode !== null) return startElectron();

  restarting = true;
  electron.once("exit", () => {
    restarting = false;
    startElectron();
  });
  electron.kill();
}

/** Content hashes of the bundles, to tell which ones a rebuild actually changed. */
function hashOutput(name: string): string {
  try {
    return createHash("sha1")
      .update(fs.readFileSync(path.join(outDir, name)))
      .digest("hex");
  } catch {
    return "";
  }
}
let mainHash = "";
let preloadHash = "";

function onRebuilt() {
  const nextMain = hashOutput("main.cjs");
  const nextPreload = hashOutput("preload.cjs");
  const mainChanged = nextMain !== mainHash;
  const preloadChanged = nextPreload !== preloadHash;
  [mainHash, preloadHash] = [nextMain, nextPreload];

  if (mainChanged || !electron || electron.exitCode !== null) {
    if (electron) console.log("[dev] main process changed, restarting Electron");
    restartElectron();
  } else if (preloadChanged && !restarting) {
    console.log("[dev] preload changed, reloading windows");
    electron.send(DEV_RELOAD_MESSAGE);
  }
}

context = await esbuild.context({
  ...electronBuildOptions,
  plugins: [
    {
      name: "restart-electron",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0 && !shuttingDown) onRebuilt();
        });
      },
    },
  ],
});
await context.watch();

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGHUP", () => shutdown(0));
