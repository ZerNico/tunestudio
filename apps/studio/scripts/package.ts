/**
 * Builds and packages the app with electron-builder for the current platform:
 *   bun scripts/package.ts [--arch arm64|x64] [--dir]
 * `--dir` only produces the unpacked app. The version comes from `TUNESTUDIO_VERSION` or
 * package.json. Installers are unsigned for now (ad-hoc signature on macOS).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type FuseV1Config, FuseV1Options, FuseVersion } from "@electron/fuses";
import { Arch, build, type Configuration, Platform } from "electron-builder";

import { APP_ID, COPYRIGHT, PRODUCT_NAME } from "../electron/identity";
import packageJson from "../package.json";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = path.join(root, ".electron-app");
const outputDir = path.join(root, "release");

const args = process.argv.slice(2);
const archName = args.includes("--arch") ? args[args.indexOf("--arch") + 1] : process.arch;
if (archName !== "arm64" && archName !== "x64") throw new Error(`Unsupported arch: ${archName}`);
// The native addon is built for this machine's processor; another one's app couldn't load it.
if (archName !== process.arch) {
  throw new Error(
    `Packaging for ${archName} needs a ${archName} machine: the native addon is built for ${process.arch}.`,
  );
}
const arch = archName === "arm64" ? Arch.arm64 : Arch.x64;
const dirOnly = args.includes("--dir");

const version = (process.env.TUNESTUDIO_VERSION ?? packageJson.version).replace(/^v/, "");
const electronVersion: string = (await import("electron/package.json")).default.version;

function run(command: string, commandArgs: string[]) {
  execFileSync(command, commandArgs, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}

/**
 * Stages a self-contained app directory: everything is bundled, so it needs no
 * node_modules, and electron-builder doesn't have to understand the Bun workspace.
 */
function stage() {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  for (const dir of ["dist", "dist-electron"]) {
    fs.cpSync(path.join(root, dir), path.join(stageDir, dir), { recursive: true });
  }
  const stagedPackage = {
    name: "tunestudio",
    productName: PRODUCT_NAME,
    version,
    description: packageJson.description,
    author: { name: "Nico Franke" },
    main: "dist-electron/main.cjs",
  };
  fs.writeFileSync(path.join(stageDir, "package.json"), JSON.stringify(stagedPackage, null, 2));
}

/** Hardening switches compiled into the Electron binary. */
const fuses: FuseV1Config = {
  version: FuseVersion.V1,
  // Nobody can run the shipped binary as a plain Node.js process, pass it Node options
  // or attach Node's inspector.
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // App code is only loaded from app.asar, and only if it matches the build.
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  // The app is served from app://, never file://.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  // Off for now: with ad-hoc signatures macOS would ask for Keychain access after every update.
  [FuseV1Options.EnableCookieEncryption]: false,
};

const config: Configuration = {
  appId: APP_ID,
  productName: PRODUCT_NAME,
  copyright: COPYRIGHT,
  electronVersion,
  directories: { output: outputDir, buildResources: path.join(root, "resources") },
  asar: true,
  // The native addon can't load from inside the archive: it, napi's loader and the WebGPU
  // library sit in the resources folder (see `nativeFolder` in main.ts).
  extraResources: [
    {
      from: path.join(root, "native"),
      to: "native",
      // The addon and the GPU libraries `scripts/native.ts` put next to it.
      filter: ["index.cjs", "*.node", "*.dylib", "*.so", "*.dll"],
    },
  ],
  // Double-clicking a project opens it in Tune Studio (macOS and the Windows installer; an AppImage registers none).
  fileAssociations: [
    {
      ext: "tunestudio",
      name: "Tune Studio project",
      description: "Tune Studio project",
      role: "Editor",
      mimeType: "application/x-tunestudio",
      icon: path.join(root, "resources/icons/icon.png"),
    },
  ],
  npmRebuild: false,
  nodeGypRebuild: false,
  mac: {
    category: "public.app-category.music",
    icon: path.join(root, "resources/icons/icon.png"),
    // No Developer ID yet: skip electron-builder's signing and sign ad-hoc in `afterPack`.
    identity: null,
    minimumSystemVersion: "12.0",
    target: dirOnly ? ["dir"] : ["dmg"],
  },
  dmg: { artifactName: `${PRODUCT_NAME}_${version}_${archName}.dmg` },
  win: {
    icon: path.join(root, "resources/icons/icon.png"),
    target: dirOnly ? ["dir"] : ["nsis"],
  },
  nsis: { artifactName: `${PRODUCT_NAME}_${version}_${archName}-setup.exe`, oneClick: true, perMachine: false },
  linux: {
    icon: path.join(root, "resources/icons/icon.png"),
    category: "AudioVideo",
    target: dirOnly ? ["dir"] : ["AppImage"],
  },
  appImage: { artifactName: `${PRODUCT_NAME}_${version}_${archName}.AppImage` },
  publish: null,

  afterPack: async (context) => {
    // Flipping fuses modifies the binary, so it has to happen before signing.
    await context.packager.addElectronFuses(context, fuses);
    if (context.electronPlatformName === "darwin") {
      const app = path.join(context.appOutDir, `${PRODUCT_NAME}.app`);
      // Ad-hoc signature: required for Apple Silicon to run the app.
      execFileSync("codesign", ["--force", "--deep", "--sign", "-", app]);
    }
  },
};

const platform =
  process.platform === "darwin" ? Platform.MAC : process.platform === "win32" ? Platform.WINDOWS : Platform.LINUX;

run("bun", ["run", "build"]);
stage();
// Building from the staging directory keeps the workspace's node_modules out of the app.
await build({ projectDir: stageDir, targets: platform.createTarget(null, arch), config });
