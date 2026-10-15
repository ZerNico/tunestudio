import { defineConfig } from "drizzle-kit";

/**
 * Generates the `.tunestudio` migrations from `electron/project/schema.ts` into `drizzle/`.
 * Run `bun run db:generate` (it also refreshes `electron/project/migrations.gen.ts`, the copy
 * bundled into the main process). There is no database to connect to: project files are
 * migrated by the app when they are opened.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./electron/project/schema.ts",
  out: "./drizzle",
});
