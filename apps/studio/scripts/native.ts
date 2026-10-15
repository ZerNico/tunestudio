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

/** ONNX Runtime's WebGPU (Dawn), downloaded by the `ort` crate next to the build. */
const LIBRARIES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "libwebgpu_dawn.dylib",
  linux: "libwebgpu_dawn.so",
  win32: "webgpu_dawn.dll",
};

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

const library = LIBRARIES[process.platform];
if (library) {
  // napi builds into target/<target triple>/<profile>; the newest copy is this build's.
  const profile = release ? "release" : "debug";
  const target = path.join(native, "target");
  const built = fs
    .readdirSync(target)
    .map((triple) => path.join(target, triple, profile, library))
    .filter((file) => fs.existsSync(file))
    .toSorted((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  // Only builds with WebGPU have it (see Cargo.toml); the others run on the CPU or DirectML.
  if (built) fs.copyFileSync(built, path.join(native, library));
}
