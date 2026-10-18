import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Rolldown } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import type { Notices } from "../../src/lib/licenses.ts";
import { javascriptEntries, normalizeLicense, packageDirOf, projectUrl, recognisedLicense } from "./collect.ts";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const hasCargo = (() => {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("licenses", () => {
  it("recognises SPDX expressions of known licenses only", () => {
    expect(recognisedLicense("MIT")).toBe(true);
    expect(recognisedLicense("(MIT OR Apache-2.0) AND Unicode-3.0")).toBe(true);
    expect(recognisedLicense("Apache-2.0 WITH LLVM-exception OR MIT")).toBe(true);
    expect(recognisedLicense("MIT/Apache-2.0")).toBe(true);
    expect(recognisedLicense("GPL-3.0-only")).toBe(false);
    expect(recognisedLicense("MIT OR SEE LICENSE IN LICENSE.md")).toBe(false);
    expect(recognisedLicense("")).toBe(false);
    expect(normalizeLicense("MIT/Apache-2.0")).toBe("MIT OR Apache-2.0");
  });

  it("links to a package's homepage, else its repository", () => {
    expect(projectUrl("https://solidjs.com", "solidjs/solid")).toBe("https://solidjs.com");
    expect(projectUrl(undefined, "Wombosvideo/tw-animate-css")).toBe("https://github.com/Wombosvideo/tw-animate-css");
    expect(projectUrl(undefined, { url: "git+https://github.com/vitejs/vite.git" })).toBe(
      "https://github.com/vitejs/vite",
    );
    expect(projectUrl(undefined, "github:lukeed/clsx")).toBe("https://github.com/lukeed/clsx");
    expect(projectUrl(undefined, undefined)).toBeNull();
  });
});

describe("packages", () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writePackage = (name: string, manifest: object, files: Record<string, string> = {}) => {
    const root = path.join(dir, "node_modules", name);
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
    // A folder-level package.json that only sets the module type isn't the package.
    fs.writeFileSync(path.join(root, "dist/package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(root, "dist/index.js"), "");
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
    return path.join(root, "dist/index.js");
  };

  it("finds each file's package and reads its license", () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "licenses-")));
    const good = writePackage("@scope/good", { license: "MIT" }, { LICENSE: "MIT text", NOTICE: "Notice text" });
    const own = path.join(dir, "src/app.ts");
    expect(packageDirOf(good)).toBe(path.join(dir, "node_modules/@scope/good"));
    expect(packageDirOf(own)).toBeNull();

    const { entries, problems } = javascriptEntries([good, good, own]);
    expect(problems).toEqual([]);
    expect(entries).toEqual([
      { name: "@scope/good", version: "1.0.0", license: "MIT", url: null, text: "MIT text\n\n\nNotice text" },
    ]);
  });

  it("reports a package with no license, an unknown one or no license file", () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "licenses-")));
    const files = [
      writePackage("unnamed", {}, { LICENSE: "text" }),
      writePackage("copyleft", { license: "GPL-3.0-only" }, { "LICENSE.md": "text" }),
      writePackage("textless", { license: "MIT" }),
    ];
    expect(javascriptEntries(files).problems.toSorted()).toEqual([
      'copyleft@1.0.0 is under "GPL-3.0-only", which isn\'t a known license.',
      "textless@1.0.0 has no license file.",
      "unnamed@1.0.0 names no license.",
    ]);
  });

  // The real build's list: Vite's graph, esbuild's metafile and the addon's crates. The build fails on any problem,
  // so this fails when a newly bundled package has no recognised license or text.
  it.skipIf(!hasCargo)(
    "lists what the build bundles and links, each with a license and its text",
    async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "licenses-build-"));
      try {
        const output = (await build({
          root: appDir,
          configFile: path.join(appDir, "vite.config.ts"),
          logLevel: "silent",
          build: { write: false, outDir },
        })) as Rolldown.RolldownOutput;
        const asset = output.output.find((item) => item.fileName === "licenses.json");
        if (asset?.type !== "asset") throw new Error("The build wrote no licenses.json");
        const notices = JSON.parse(String(asset.source)) as Notices;

        const names = (list: readonly { name: string }[]) => list.map((entry) => entry.name);
        expect(names(notices.javascript)).toEqual(
          expect.arrayContaining(["solid-js", "effect", "drizzle-orm", "tailwindcss", "@iconify-json/lucide"]),
        );
        // Build tools that leave no code behind aren't listed, nor are our own packages.
        for (const absent of ["typescript", "vitest", "esbuild", "electron", "@tunestudio/ultrastar"]) {
          expect(names(notices.javascript)).not.toContain(absent);
        }
        expect(names(notices.crates)).toEqual(expect.arrayContaining(["napi", "ort", "whisper-rs"]));
        // Compile-time crates (build scripts, proc macros) aren't linked.
        expect(names(notices.crates)).not.toContain("napi-build");
        expect(names(notices.crates)).not.toContain("napi-derive");
        expect(names(notices.libraries)).toEqual(expect.arrayContaining(["ONNX Runtime", "whisper.cpp and ggml"]));
        expect(notices.electron?.name).toBe("Electron");
        for (const entry of [...notices.javascript, ...notices.crates, ...notices.libraries]) {
          expect(notices.texts[entry.text], entry.name).toMatch(/\S/);
        }
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
