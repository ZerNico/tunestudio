fn main() {
    napi_build::setup();
    // Which GPU runtime ort has for this target (the features in Cargo.toml), as `cfg(gpu = …)`.
    println!("cargo::rustc-check-cfg=cfg(gpu, values(\"webgpu\", \"directml\"))");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    match (os.as_str(), arch.as_str()) {
        ("macos", "aarch64") | ("windows", "x86_64") | ("linux", "x86_64") => println!("cargo:rustc-cfg=gpu=\"webgpu\""),
        ("windows", "aarch64") => println!("cargo:rustc-cfg=gpu=\"directml\""),
        _ => {}
    }
    // Whisper's GPU backend is Vulkan here (the `vulkan` feature in Cargo.toml), as `cfg(vulkan)`.
    println!("cargo::rustc-check-cfg=cfg(vulkan)");
    if arch == "x86_64" && (os == "windows" || os == "linux") {
        println!("cargo:rustc-cfg=vulkan");
    }
    // The WebGPU runtime (Dawn) ships as a library next to the addon.
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") => {
            println!("cargo:rustc-link-arg=-Wl,-rpath,@loader_path");
            link_clang_runtime();
        }
        Ok("linux") => println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN"),
        _ => {}
    }
}

/// ONNX Runtime checks the macOS version with `@available`, whose helper lives in clang's
/// runtime library. Rust doesn't link that, and since Node addons resolve missing symbols when
/// loaded, the check would call a null pointer instead of failing to build.
fn link_clang_runtime() {
    let output = std::process::Command::new("clang")
        .arg("--print-resource-dir")
        .output()
        .expect("clang is needed to build on macOS");
    let resources = String::from_utf8(output.stdout).expect("clang prints a path");
    println!("cargo:rustc-link-search=native={}/lib/darwin", resources.trim());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
