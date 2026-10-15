import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

import { DEV_SERVER_PORT } from "./scripts/dev-port.ts";
import { iconsPlugin } from "./scripts/icons-plugin.ts";

export default defineConfig({
  plugins: [tanstackRouter({ target: "solid", autoCodeSplitting: true }), solid(), tailwindcss(), iconsPlugin()],
  resolve: { alias: { "~": "/src" } },
  server: {
    port: DEV_SERVER_PORT,
    strictPort: true,
    host: "localhost",
    watch: { ignored: ["**/electron/**", "**/dist-electron/**", "**/e2e/**", "**/release/**"] },
  },
  build: { target: "esnext" },
});
