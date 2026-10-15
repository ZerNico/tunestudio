//! The singer's pitch: FCPE (fcpe-onnx: torchfcpe's bundled model with its mel spectrogram and
//! decoding in the graph) over the whole vocal track at once, as the PoC runs it.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use ort::value::Tensor;

use crate::runtime::{self, Device, ModelSource};

pub struct Pitch {
    model: String,
    samples: Vec<f32>,
}

impl Task for Pitch {
    type Output = Vec<f32>;
    type JsValue = Float32Array;

    fn compute(&mut self) -> Result<Self::Output> {
        let failed = |error: String| Error::from_reason(format!("Following the melody failed: {error}"));
        let mut session = runtime::session(ModelSource::File(&self.model), Device::Cpu, "The pitch model")?;
        let samples = std::mem::take(&mut self.samples);
        let input = Tensor::from_array(([1usize, samples.len()], samples.into_boxed_slice())).map_err(|e| failed(e.to_string()))?;
        let outputs = session.run(ort::inputs!["audio" => input]).map_err(|e| failed(e.to_string()))?;
        let (_, f0) = outputs["f0"].try_extract_tensor::<f32>().map_err(|e| failed(e.to_string()))?;
        Ok(f0.to_vec())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(Float32Array::new(output))
    }
}

/// The pitch in Hz every 10 ms (0 where unvoiced) of a mono 16 kHz vocal track, with the FCPE
/// model at `model`: `samples / 160 + 1` values. Runs on a worker thread.
#[napi(ts_return_type = "Promise<Float32Array>")]
pub fn track_pitch(model: String, samples: Float32Array) -> Result<AsyncTask<Pitch>> {
    // FCPE mirrors the audio at its edges for its spectrogram, which needs more than one window.
    if samples.len() < 1024 {
        return Err(Error::new(Status::InvalidArg, "The vocals are too short to follow the melody."));
    }
    Ok(AsyncTask::new(Pitch { model, samples: samples.to_vec() }))
}
