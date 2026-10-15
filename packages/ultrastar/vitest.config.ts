import { defineConfig } from "vitest/config";

/** Pure TypeScript, so every test runs in Node without a DOM. */
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
