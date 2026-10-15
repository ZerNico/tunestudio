/**
 * Builds the native addon (`native/`) with napi and puts the libraries it loads at runtime next
 * to it, where the app looks for them:
 *   bun scripts/native.ts [--release]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const native = path.join(root, "native");
const release = process.argv.includes("--release");

/**
 * The GPU libraries ONNX Runtime loads, which the `ort` crate downloads next to the build (see
 * Cargo.toml for which runtime each system gets): WebGPU's Dawn, with DirectX's shader compiler
 * on Windows, and DirectML on Windows on ARM. Linux on ARM runs on the CPU and needs none.
 */
const LIBRARIES: Record<string, string[]> = {
  "darwin-arm64": ["libwebgpu_dawn.dylib"],
  "linux-x64": ["libwebgpu_dawn.so"],
  "linux-arm64": [],
  "win32-x64": ["webgpu_dawn.dll", "dxcompiler.dll"],
  "win32-arm64": ["DirectML.dll"],
};

const system = `${process.platform}-${process.arch}`;
const libraries = LIBRARIES[system];
if (!libraries) {
  // Intel Macs among them: ONNX Runtime publishes no build for them.
  throw new Error(`The native addon can't be built on ${system}: ONNX Runtime has no build for it.`);
}

// Releases run on other machines: otherwise whisper.cpp targets this processor exactly, and older
// ones crash. Off, x64 needs AVX2 and FMA, ARM the base set. Applies when whisper-rs-sys is rebuilt.
const env = release ? { ...process.env, GGML_NATIVE: process.env.GGML_NATIVE ?? "OFF" } : process.env;

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
