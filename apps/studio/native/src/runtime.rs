//! ONNX Runtime, shared by the models: the process-wide environment and sessions on the GPU (where
//! ort ships a runtime for this system) or the CPU.

use std::sync::OnceLock;

use napi::bindgen_prelude::*;
use ort::session::{builder::AutoDevicePolicy, Session};

/// ONNX Runtime's process-wide environment, created on first use.
pub fn environment() -> Result<&'static ort::environment::Environment> {
    static ENVIRONMENT: OnceLock<std::result::Result<ort::environment::Environment, String>> = OnceLock::new();
    ENVIRONMENT
        .get_or_init(|| ort::init().with_name("tunestudio").build().map_err(|error| error.to_string()))
        .as_ref()
        .map_err(|error| Error::from_reason(format!("The model runtime couldn't start: {error}")))
}

/// The GPU runtime ort ships for this system, if any (`gpu` comes from build.rs).
pub fn gpu_provider() -> Option<ort::ep::ExecutionProviderDispatch> {
    #[cfg(gpu = "webgpu")]
    return Some(ort::ep::WebGPU::default().build().error_on_failure());
    #[cfg(gpu = "directml")]
    return Some(ort::ep::DirectML::default().build().error_on_failure());
    #[allow(unreachable_code)]
    None
}

/// Where a session runs.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Gpu,
    Cpu,
}

/// A session for an ONNX model, given as a file or as bytes (a model changed after loading).
pub enum ModelSource<'a> {
    File(&'a str),
    Bytes(&'a [u8]),
}

/// A session for `model` on `device`; `what` names the model in errors ("the separation model").
pub fn session(model: ModelSource, device: Device, what: &str) -> Result<Session> {
    let failed = |error: String| Error::from_reason(format!("{what} couldn't be loaded: {error}"));
    let builder = Session::builder(environment()?).map_err(|e| failed(e.to_string()))?;
    let mut builder = match device {
        Device::Gpu => {
            let provider = gpu_provider().ok_or_else(|| Error::from_reason("No GPU runtime for this system."))?;
            builder.with_execution_providers([provider]).map_err(|e| failed(e.to_string()))?
        }
        // ort's default device policy picks Core ML on macOS even with only the CPU registered
        // (pykeio/ort#662), and Core ML can't run these models.
        // Without the CPU arena and memory pattern, each tensor is allocated on its own: the arena
        // grows in ever larger aligned blocks, and inside Electron (Chromium's allocator) one that
        // can't be had aborts the whole app instead of failing the run.
        Device::Cpu => builder
            .with_auto_device(AutoDevicePolicy::PreferCPU)
            .and_then(|builder| builder.with_execution_providers([ort::ep::CPU::default().with_arena_allocator(false).build()]))
            .and_then(|builder| builder.with_memory_pattern(false))
            .map_err(|e| failed(e.to_string()))?,
    };
    match model {
        ModelSource::File(path) => builder.commit_from_file(path).map_err(|e| failed(e.to_string())),
        ModelSource::Bytes(bytes) => builder.commit_from_memory(bytes).map_err(|e| failed(e.to_string())),
    }
}
