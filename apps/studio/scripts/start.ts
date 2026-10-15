import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";

/**
 * Runs the production build (`bun run build`) in Electron without packaging it: the renderer
 * is served from `dist/` on the app:// scheme, exactly like in a packaged app.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { ELECTRON_RUN_AS_NODE: _, TUNESTUDIO_DEV_SERVER_URL: __, ...env } = process.env;

spawn(String(electronPath), [".", ...process.argv.slice(2)], { cwd: root, stdio: "inherit", env }).on("exit", (code) =>
  process.exit(code ?? 0),
);
