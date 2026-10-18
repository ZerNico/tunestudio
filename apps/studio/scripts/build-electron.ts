import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BuildOptions } from "esbuild";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Bundles the Electron main process and preload script to CommonJS in `dist-electron/`. */
export const electronBuildOptions: BuildOptions = {
  entryPoints: { main: "electron/main.ts", preload: "electron/preload.ts" },
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
};

/** The charting's generated tables go beside the bundle, read from there on first use (`electron/charting/tables.ts`). */
export function copyChartingTables() {
  fs.cpSync(path.join(root, "electron/charting/data"), path.join(root, "dist-electron/data"), { recursive: true });
}

if (import.meta.main) {
  await esbuild.build(electronBuildOptions);
  copyChartingTables();
}
