import { fileURLToPath } from "node:url";

import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";

import { iconsPlugin } from "./scripts/icons-plugin.ts";

const alias = { "~": fileURLToPath(new URL("./src", import.meta.url)) };

/**
 * Projects are split by extension: `unit` is `src/**\/*.test.ts` (node), `ui` is
 * `src/**\/*.test.tsx` (jsdom, rendered with Solid's browser dev build), `electron` is
 * `electron/**\/*.test.ts` (node). The Electron e2e tests are Playwright (`test:e2e`).
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "unit", include: ["src/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias },
        // Solid's dev build (dev warnings, `development` condition) without the HMR wrappers.
        plugins: [solid({ hot: false }), iconsPlugin()],
        test: {
          name: "ui",
          include: ["src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./tests/setup.ui.ts"],
        },
      },
      {
        test: { name: "electron", include: ["electron/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
