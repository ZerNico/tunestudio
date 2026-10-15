import { defineConfig } from "@playwright/test";

/** End-to-end tests drive the built app in Electron (`bun run build` first; turbo does that for `test:e2e`). */
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
});
