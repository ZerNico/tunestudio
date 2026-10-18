/**
 * The GPU libraries ONNX Runtime loads, which the `ort` crate downloads next to the build (see
 * Cargo.toml for which runtime each system gets): WebGPU's Dawn, with DirectX's shader compiler
 * on Windows, and DirectML on Windows on ARM. Linux on ARM runs on the CPU and needs none.
 * `scripts/native.ts` puts them beside the addon; `scripts/check-package.ts` checks the app has them.
 */
export const GPU_LIBRARIES: Record<string, string[]> = {
  "darwin-arm64": ["libwebgpu_dawn.dylib"],
  "linux-x64": ["libwebgpu_dawn.so"],
  "linux-arm64": [],
  "win32-x64": ["webgpu_dawn.dll", "dxcompiler.dll"],
  "win32-arm64": ["DirectML.dll"],
};

/**
 * The systems whose addon runs Whisper on the GPU through Vulkan (`cfg(vulkan)` in `native/build.rs`). It doesn't link
 * the Vulkan loader (`native/src/vulkan.rs`); `scripts/check-package.ts` checks that it doesn't.
 */
export const VULKAN_SYSTEMS = new Set(["linux-x64", "win32-x64"]);

/** `darwin-arm64`, `win32-x64`, ...: this machine, which the addon is built for. */
export const currentSystem = () => `${process.platform}-${process.arch}`;

/**
 * Microsoft's C++ runtime, which the Windows addon, Dawn and DXC link (`msvcp140*.dll`, `vcruntime140*.dll`) and a PC
 * without a recent Visual C++ Redistributable lacks. `scripts/native.ts` copies it from Visual Studio next to them
 * (app-local, as Microsoft allows for these files).
 */
export const isCppRuntime = (file: string) => /^(msvcp140|vcruntime140)(_\w+)?\.dll$/i.test(file);
