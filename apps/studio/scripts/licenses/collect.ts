/**
 * Collects the third-party notices for the build (`plugin.ts` writes them to `dist/licenses.json`): the npm packages
 * that end up in the renderer and main-process bundles, the Rust crates linked into the native addon, the C/C++
 * libraries that come with them, and Electron. A package without a recognised license or a license text is a
 * problem: the build fails until it is looked at (`MISSING_TEXTS` takes the text from `texts/` when it really has
 * no file).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import type { Notice, Notices } from "../../src/lib/licenses.ts";
import { electronBuildOptions } from "../build-electron.ts";
import { currentSystem, GPU_LIBRARIES } from "../native-libraries.ts";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const textsDir = path.join(appDir, "scripts/licenses/texts");

/** SPDX license IDs the app may ship. Copyleft licenses are left out on purpose: one appearing fails the build. */
const KNOWN_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC0-1.0",
  "CDLA-Permissive-2.0",
  "ISC",
  "MIT",
  "MIT-0",
  "NCSA",
  "OFL-1.1",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "Zlib",
]);
const KNOWN_EXCEPTIONS = new Set(["LLVM-exception"]);

/** Packages that ship no license file, and the file in `texts/` that says what applies. */
const MISSING_TEXTS: Record<string, string> = {
  "@iconify-json/lucide": "lucide.txt",
  "@solidjs/web": "solid.txt",
  "drizzle-orm": "drizzle-orm.txt",
  napi: "napi-rs.txt",
  "napi-sys": "napi-rs.txt",
  realfft: "realfft.txt",
  "solid-js": "solid.txt",
  "whisper-rs-sys": "unlicense.txt",
};

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-_.].*)?$/i;

/** A notice before its text is put in the shared list. */
export type Entry = Omit<Notice, "text"> & { text: string };

export interface Collected {
  javascript: Entry[];
  libraries: Entry[];
  crates: Entry[];
  electron: Entry;
  /** What needs looking at; the build fails unless this is empty. */
  problems: string[];
}

/** Whether `expression` is an SPDX expression of known licenses (`MIT OR Apache-2.0`, `(MIT OR Apache-2.0) AND Unicode-3.0`). */
export function recognisedLicense(expression: string): boolean {
  const tokens = normalizeLicense(expression)
    .replaceAll(/[()]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !["AND", "OR", "WITH"].includes(token));
  return tokens.length > 0 && tokens.every((token) => KNOWN_LICENSES.has(token) || KNOWN_EXCEPTIONS.has(token));
}

/** Old Cargo manifests write `MIT/Apache-2.0` for `MIT OR Apache-2.0`. */
export function normalizeLicense(expression: string): string {
  return expression.trim().replaceAll(/\s*\/\s*/g, " OR ");
}

/** The license files in a package's folder, LICENSE first, joined. */
export function licenseText(dir: string, extra: string[] = []): string | null {
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .toSorted((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const files = [...new Set([...names.map((name) => path.join(dir, name)), ...extra])];
  const texts = files.map((file) => fs.readFileSync(file, "utf8").replace(/^﻿/, "").trim()).filter(Boolean);
  return texts.length > 0 ? texts.join("\n\n\n") : null;
}

/** LICENSE before NOTICE: the license is what most people look for. */
const rank = (name: string) => (/^notice/i.test(name) ? 1 : 0);

const committedText = (file: string) => fs.readFileSync(path.join(textsDir, file), "utf8").trim();

/** A link to the project: its homepage, or its repository as a web address. */
export function projectUrl(homepage: unknown, repository: unknown): string | null {
  if (typeof homepage === "string" && /^https?:\/\//.test(homepage)) return homepage;
  const raw = typeof repository === "string" ? repository : (repository as { url?: unknown } | undefined)?.url;
  if (typeof raw !== "string") return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  const github = /^github:(.+)$/.exec(raw);
  if (github) return `https://github.com/${github[1]}`;
  const url = raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
  return /^https?:\/\//.test(url) ? url : null;
}

interface PackageJson {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: (string | { type?: string })[];
  homepage?: unknown;
  repository?: unknown;
}

/** The npm package's license as one SPDX expression. */
function packageLicense(manifest: PackageJson): string | null {
  const one = (value: string | { type?: string } | undefined) => (typeof value === "string" ? value : value?.type);
  if (manifest.license) return one(manifest.license) ?? null;
  const all = (manifest.licenses ?? []).map(one).filter((value): value is string => Boolean(value));
  return all.length > 0 ? all.join(" OR ") : null;
}

/** The notice for the npm package in `dir`, and what is wrong with it. */
export function packageEntry(dir: string): { entry: Entry; problems: string[] } {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
  const name = manifest.name ?? path.basename(dir);
  const license = packageLicense(manifest);
  const fallback = MISSING_TEXTS[name];
  const text = licenseText(dir) ?? (fallback ? committedText(fallback) : null);
  return {
    entry: {
      name,
      version: manifest.version ?? null,
      license: license ? normalizeLicense(license) : "Unknown",
      url: projectUrl(manifest.homepage, manifest.repository),
      text: text ?? "",
    },
    problems: check(`${name}@${manifest.version}`, license, text),
  };
}

function check(id: string, license: string | null | undefined, text: string | null): string[] {
  const problems: string[] = [];
  if (!license) problems.push(`${id} names no license.`);
  else if (!recognisedLicense(license)) problems.push(`${id} is under "${license}", which isn't a known license.`);
  if (!text) problems.push(`${id} has no license file.`);
  return problems;
}

/** The folder of the installed package `file` belongs to; null for the app's own and the workspace's files. */
export function packageDirOf(file: string): string | null {
  if (!file.split(path.sep).includes("node_modules")) return null;
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const { name, version } = JSON.parse(fs.readFileSync(manifest, "utf8")) as PackageJson;
      // Packages keep folder-level package.json files with only a "type" in them.
      if (name && version) return dir;
    }
    if (path.basename(path.dirname(dir)) === "node_modules") break;
    dir = path.dirname(dir);
  }
  return null;
}

/** Where the package `name` is installed for code in `fromDir`, as Node would find it. */
export function findPackage(name: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return fs.realpathSync(path.dirname(candidate));
    if (dir === path.dirname(dir)) return null;
    dir = path.dirname(dir);
  }
}

/** The files in the main process and preload bundles, from esbuild's metafile (the same options as the build). */
export async function mainProcessFiles(): Promise<string[]> {
  const result = await esbuild.build({
    ...electronBuildOptions,
    absWorkingDir: appDir,
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const files = new Set<string>();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      if (bytesInOutput > 0 && !input.includes(":")) files.add(path.resolve(appDir, input));
    }
  }
  return [...files];
}

/** The notices of the packages these files come from (the app's and the workspace's own are skipped). */
export function javascriptEntries(files: Iterable<string>, packageDirs: Iterable<string> = []) {
  const dirs = new Set(packageDirs);
  for (const file of files) {
    const dir = packageDirOf(file);
    if (dir) dirs.add(fs.realpathSync(dir));
  }
  const entries = new Map<string, Entry>();
  const problems: string[] = [];
  for (const dir of dirs) {
    const found = packageEntry(dir);
    if (found.entry.name.startsWith("@tunestudio/")) continue;
    const key = `${found.entry.name}@${found.entry.version}`;
    if (entries.has(key)) continue;
    entries.set(key, found.entry);
    problems.push(...found.problems);
  }
  return { entries: sortEntries([...entries.values()]), problems };
}

const sortEntries = (entries: Entry[]) =>
  entries.toSorted((a, b) => a.name.localeCompare(b.name) || (a.version ?? "").localeCompare(b.version ?? ""));

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  license: string | null;
  license_file: string | null;
  repository: string | null;
  homepage: string | null;
  manifest_path: string;
  targets: { kind: string[] }[];
}
interface CargoMetadata {
  packages: CargoPackage[];
  resolve: { root: string; nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] };
}

/** This machine's Rust target (`aarch64-apple-darwin`); the addon is built for it. */
export function hostTriple(): string {
  const triple = /^host: (\S+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
  if (!triple) throw new Error("Couldn't tell this machine's target from `rustc -vV`.");
  return triple;
}

/** The crates the addon links for `triple`: normal dependencies, not build scripts' or proc macros' (compile time only). */
export function linkedCrates(metadata: CargoMetadata): CargoPackage[] {
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const queue = [metadata.resolve.root];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      const crate = packages.get(dep.pkg);
      const normal = dep.dep_kinds.some((kind) => kind.kind === null);
      const procMacro = crate?.targets.some((target) => target.kind.includes("proc-macro"));
      if (normal && !procMacro) queue.push(dep.pkg);
    }
  }
  seen.delete(metadata.resolve.root);
  return [...seen].map((id) => packages.get(id)!);
}

/** The addon's crates and what comes with them, for this machine. */
export function nativeEntries(manifestPath = path.join(appDir, "native/Cargo.toml"), system = currentSystem()) {
  const output = execFileSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--filter-platform",
      hostTriple(),
      "--manifest-path",
      manifestPath,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const crates = linkedCrates(JSON.parse(output) as CargoMetadata);
  const problems: string[] = [];
  const entries = crates.map((crate) => {
    const dir = path.dirname(crate.manifest_path);
    const extra = crate.license_file ? [path.resolve(dir, crate.license_file)] : [];
    const fallback = MISSING_TEXTS[crate.name];
    const text = licenseText(dir, extra) ?? (fallback ? committedText(fallback) : null);
    problems.push(...check(`${crate.name}@${crate.version}`, crate.license, text));
    return {
      name: crate.name,
      version: crate.version,
      license: crate.license ? normalizeLicense(crate.license) : "Unknown",
      url: projectUrl(crate.homepage, crate.repository),
      text: text ?? "",
    };
  });
  const libraries = nativeLibraries(crates, system);
  return { crates: sortEntries(entries), libraries: libraries.entries, problems: [...problems, ...libraries.problems] };
}

/** The systems whose addon loads WebGPU's Dawn. */
const DAWN_SYSTEMS = new Set(
  Object.entries(GPU_LIBRARIES)
    .filter(([, libraries]) => libraries.some((library) => library.includes("webgpu_dawn")))
    .map(([system]) => system),
);

/**
 * The C and C++ code the crates bring: whisper.cpp (built from whisper-rs-sys's sources), ONNX Runtime (pyke's
 * prebuilt static library, version from ort-sys's download list), the GPU libraries that come with it, and clang's
 * runtime on macOS (`native/build.rs`). Their texts come from the sources where they are there, else from `texts/`.
 */
export function nativeLibraries(crates: CargoPackage[], system: string) {
  const entries: Entry[] = [];
  const problems: string[] = [];
  const crateDir = (name: string) => {
    const crate = crates.find((entry) => entry.name === name);
    if (!crate) problems.push(`The addon no longer links ${name}: update nativeLibraries.`);
    return crate ? path.dirname(crate.manifest_path) : null;
  };

  const whisperSys = crateDir("whisper-rs-sys");
  if (whisperSys) {
    const cmake = fs.readFileSync(path.join(whisperSys, "whisper.cpp/CMakeLists.txt"), "utf8");
    entries.push({
      name: "whisper.cpp and ggml",
      version: /project\("whisper\.cpp" VERSION ([\d.]+)\)/.exec(cmake)?.[1] ?? null,
      license: "MIT",
      url: "https://github.com/ggml-org/whisper.cpp",
      text: fs.readFileSync(path.join(whisperSys, "whisper.cpp/LICENSE"), "utf8").trim(),
    });
  }

  const ortSys = crateDir("ort-sys");
  if (ortSys) {
    const list = fs.readFileSync(path.join(ortSys, "build/download/dist.tsv"), "utf8");
    const version = /\/ms@(\d+\.\d+\.\d+)\//.exec(list)?.[1];
    const license = `onnxruntime-${version}-LICENSE.txt`;
    const notices = `onnxruntime-${version}-ThirdPartyNotices.txt`;
    if (!version || !fs.existsSync(path.join(textsDir, license)) || !fs.existsSync(path.join(textsDir, notices))) {
      problems.push(
        `ONNX Runtime ${version ?? "(unknown version)"} has no texts in scripts/licenses/texts: add its LICENSE and ThirdPartyNotices.txt from that release.`,
      );
    } else {
      entries.push({
        name: "ONNX Runtime",
        version,
        license: "MIT",
        url: "https://github.com/microsoft/onnxruntime",
        text: `${committedText(license)}\n\n\n${committedText(notices)}`,
      });
    }
  }

  if (DAWN_SYSTEMS.has(system)) {
    entries.push({
      name: "Dawn (WebGPU)",
      version: null,
      license: "BSD-3-Clause",
      url: "https://dawn.googlesource.com/dawn",
      text: committedText("dawn.txt"),
    });
  }
  if (system === "win32-x64") {
    entries.push({
      name: "DirectX Shader Compiler",
      version: null,
      license: "NCSA",
      url: "https://github.com/microsoft/DirectXShaderCompiler",
      text: committedText("directx-shader-compiler.txt"),
    });
  }
  if (system === "win32-arm64") {
    entries.push({
      name: "DirectML",
      version: null,
      license: "Microsoft DirectML License",
      url: "https://github.com/microsoft/DirectML",
      text: `${committedText("directml.txt")}\n\n\n${committedText("directml-ThirdPartyNotices.txt")}`,
    });
  }
  if (system.startsWith("darwin-")) {
    entries.push({
      name: "LLVM compiler-rt",
      version: null,
      license: "Apache-2.0 WITH LLVM-exception",
      url: "https://compiler-rt.llvm.org",
      text: committedText("llvm-compiler-rt.txt"),
    });
  }
  return { entries, problems };
}

/** Electron's own license, from the copy that ships with it. Chromium's is opened from the app's folder instead. */
export function electronEntry(): Entry {
  const dir = findPackage("electron", appDir);
  if (!dir) throw new Error("Electron isn't installed.");
  const { version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
  return {
    name: "Electron",
    version: version ?? null,
    license: "MIT",
    url: "https://www.electronjs.org",
    text: fs.readFileSync(path.join(dir, "LICENSE"), "utf8").trim(),
  };
}

/** Everything the notices list, from the renderer's files (Vite's graph) and packages (CSS imports, icons). */
export async function collect(renderer: {
  files: Iterable<string>;
  packageDirs: Iterable<string>;
}): Promise<Collected> {
  const javascript = javascriptEntries([...renderer.files, ...(await mainProcessFiles())], renderer.packageDirs);
  const native = nativeEntries();
  return {
    javascript: javascript.entries,
    libraries: native.libraries,
    crates: native.crates,
    electron: electronEntry(),
    problems: [...javascript.problems, ...native.problems],
  };
}

/** The notices as the renderer reads them, each text stored once. */
export function toNotices(collected: Collected): Notices {
  const texts: string[] = [];
  const index = new Map<string, number>();
  const withText = (entry: Entry): Notice => {
    let at = index.get(entry.text);
    if (at === undefined) {
      at = texts.push(entry.text) - 1;
      index.set(entry.text, at);
    }
    return { ...entry, text: at };
  };
  return {
    generated: true,
    javascript: collected.javascript.map(withText),
    libraries: collected.libraries.map(withText),
    crates: collected.crates.map(withText),
    electron: withText(collected.electron),
    texts,
  };
}
