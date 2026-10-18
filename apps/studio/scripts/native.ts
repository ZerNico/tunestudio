/**
 * Builds the native addon (`native/`) with napi and puts the libraries it loads at runtime next
 * to it, where the app looks for them:
 *   bun scripts/native.ts [--release]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { currentSystem, GPU_LIBRARIES, isCppRuntime } from "./native-libraries.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const native = path.join(root, "native");
const release = process.argv.includes("--release");

const system = currentSystem();
const libraries = GPU_LIBRARIES[system];
if (!libraries) {
  // Intel Macs among them: ONNX Runtime publishes no build for them.
  throw new Error(`The native addon can't be built on ${system}: ONNX Runtime has no build for it.`);
}

const env = { ...process.env };
// Releases run on other machines: otherwise whisper.cpp targets this processor exactly, and older
// ones crash. Off, x64 needs AVX2 and FMA, ARM the base set. Applies when whisper-rs-sys is rebuilt.
if (release) env.GGML_NATIVE ??= "OFF";
// With MSVC the cmake crate replaces CMake's flags for the build type with its own minus `/O`, so
// whisper.cpp was compiled without optimizing and Whisper ran 12 times slower. whisper-rs-sys
// passes `CMAKE_*` variables on, and flags given that way are kept. Also when it is rebuilt.
if (process.platform === "win32") {
  for (const language of ["C", "CXX"]) env[`CMAKE_${language}_FLAGS_RELEASE`] ??= "/MD /O2 /Ob2 /DNDEBUG";
  // ggml's Vulkan backend builds its shader generator as a CMake project of its own, which a Visual
  // Studio build can't configure (it finds no compiler). With Ninja it gets the compiler's environment.
  if (process.arch === "x64") env.CMAKE_GENERATOR ??= "Ninja";
}

execFileSync(
  "napi",
  [
    "build",
    "--platform",
    "--manifest-path",
    "native/Cargo.toml",
    "--output-dir",
    "native",
    "--js",
    "index.cjs",
    "--dts",
    "index.d.ts",
    ...(release ? ["--release"] : []),
  ],
  { cwd: root, stdio: "inherit", shell: process.platform === "win32", env },
);

// napi builds for this machine into target/<its target triple>/<profile>.
const triple = /^host: (\S+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
if (!triple) throw new Error("Couldn't tell this machine's target from `rustc -vV`.");
const built = path.join(native, "target", triple, release ? "release" : "debug");
for (const library of libraries) {
  const file = path.join(built, library);
  if (!fs.existsSync(file)) throw new Error(`${library} is missing from ${built}: the GPU runtime wouldn't load.`);
  fs.copyFileSync(file, path.join(native, library));
}
if (process.platform === "win32") copyCppRuntime();

/** Copies the C++ runtime (`isCppRuntime`) from the newest Visual C++ redistributable files Visual Studio has. */
function copyCppRuntime() {
  const installer = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio/Installer",
  );
  const studio = execFileSync(
    path.join(installer, "vswhere.exe"),
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8" },
  ).trim();
  const redist = path.join(studio, "VC/Redist/MSVC");
  const newest = fs
    .readdirSync(redist)
    .filter((name) => /^\d+(\.\d+)+$/.test(name))
    .toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .at(-1);
  const folder = newest ? path.join(redist, newest, process.arch === "arm64" ? "arm64" : "x64") : null;
  const crt = folder && fs.readdirSync(folder).find((name) => /^Microsoft\.VC\d+\.CRT$/.test(name));
  if (!folder || !crt) throw new Error(`No Visual C++ runtime in ${redist}: install Visual Studio's C++ build tools.`);
  for (const file of fs.readdirSync(path.join(folder, crt)).filter(isCppRuntime)) {
    fs.copyFileSync(path.join(folder, crt, file), path.join(native, file));
  }
}
