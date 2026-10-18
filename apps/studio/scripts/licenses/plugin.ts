import fs from "node:fs";
import path from "node:path";

import type { Plugin } from "vite";

import { NOTICES_PATH, type Notices } from "../../src/lib/licenses.ts";
import { collect, findPackage, toNotices } from "./collect.ts";

/** The packages behind Vite's and unplugin-icons' generated modules (`\0vite/preload-helper.js`, `~icons/lucide/x`). */
function generatedModulePackage(id: string): string | null {
  const icons = /~icons\/([^/]+)\//.exec(id);
  if (icons) return `@iconify-json/${icons[1]}`;
  if (id.startsWith("\0vite/")) return "vite";
  if (id.startsWith("\0rolldown/")) return "rolldown";
  return null;
}

const EMPTY: Notices = { generated: false, javascript: [], libraries: [], crates: [], electron: null, texts: [] };

/**
 * Writes the third-party notices (`collect.ts`) to `dist/licenses.json` at the end of a build, from what the renderer
 * bundle really holds: the modules Vite rendered, the packages CSS files import (Tailwind, fonts) and the files of
 * emitted assets. The dev server serves the last build's file, or empty lists before there is one.
 */
export function licensesPlugin(): Plugin {
  let root = process.cwd();
  let outDir = "dist";
  /** Packages imported by CSS files, which Tailwind resolves outside Vite's module graph. */
  const cssPackages = new Set<string>();

  return {
    name: "tunestudio:licenses",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(NOTICES_PATH, (_request, response) => {
        const built = path.join(outDir, NOTICES_PATH);
        response.setHeader("Content-Type", "application/json");
        response.end(fs.existsSync(built) ? fs.readFileSync(built) : JSON.stringify(EMPTY));
      });
    },
    transform(code, id) {
      if (this.environment.mode !== "build" || !/\.css(\?|$)/.test(id) || id.startsWith("\0")) return;
      for (const [, specifier] of code.matchAll(/@import\s+["']([^"'./][^"']*)["']/g)) {
        const parts = specifier!.split("/");
        const name = specifier!.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
        const dir = findPackage(name, path.dirname(id));
        if (dir) cssPackages.add(dir);
      }
    },
    async generateBundle(_options, bundle) {
      const files = new Set<string>();
      const packageDirs = new Set(cssPackages);
      const addPackage = (name: string, from: string) => {
        const dir = findPackage(name, from);
        if (!dir) this.error(`Couldn't find ${name}, whose code is in the bundle.`);
        packageDirs.add(dir);
      };
      for (const item of Object.values(bundle)) {
        if (item.type === "asset") {
          for (const name of item.originalFileNames) files.add(path.resolve(root, name));
          continue;
        }
        for (const [id, module] of Object.entries(item.modules)) {
          if (module.renderedLength === 0) continue;
          const generated = generatedModulePackage(id);
          if (generated) addPackage(generated, generated === "rolldown" ? findPackage("vite", root)! : root);
          else if (path.isAbsolute(id)) files.add(id.replace(/\?.*$/, ""));
        }
      }
      const collected = await collect({ files, packageDirs });
      if (collected.problems.length > 0) {
        this.error(
          `Some bundled code has no usable license (see scripts/licenses/collect.ts):\n${collected.problems.join("\n")}`,
        );
      }
      this.emitFile({ type: "asset", fileName: NOTICES_PATH.slice(1), source: JSON.stringify(toNotices(collected)) });
    },
  };
}
