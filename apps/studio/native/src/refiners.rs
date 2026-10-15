//! The learned corrections after GAME (tunestudio-note-refiners, gradient-boosted trees exported
//! to ONNX): per note, the probabilities of shifting its pitch by -2..2 semitones, and how many
//! seconds to move its end. The features come from TypeScript (electron/charting/refiners.ts).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use ort::value::Tensor;

use crate::runtime::{self, Device, ModelSource};

/// Runs a refiner on `rows` notes of `width` features each and returns its `output`.
fn predict(model: &str, what: &str, features: &[f32], width: usize, output: &str) -> Result<Vec<f32>> {
    let rows = features.len() / width;
    let failed = |error: String| Error::from_reason(format!("{what} failed: {error}"));
    let mut session = runtime::session(ModelSource::File(model), Device::Cpu, what)?;
    let input = Tensor::from_array(([rows, width], features.to_vec().into_boxed_slice())).map_err(|e| failed(e.to_string()))?;
    let outputs = session.run(ort::inputs!["features" => input]).map_err(|e| failed(e.to_string()))?;
    let (_, values) = outputs[output].try_extract_tensor::<f32>().map_err(|e| failed(e.to_string()))?;
    Ok(values.to_vec())
}

pub struct Refine {
    model: String,
    features: Vec<f32>,
    width: usize,
    output: &'static str,
    what: &'static str,
}

impl Task for Refine {
    type Output = Vec<f32>;
    type JsValue = Float32Array;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.features.is_empty() {
            return Ok(Vec::new());
        }
        predict(&self.model, self.what, &self.features, self.width, self.output)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(Float32Array::new(output))
    }
}

fn refine(model: String, features: Float32Array, width: usize, output: &'static str, what: &'static str) -> Result<AsyncTask<Refine>> {
    if features.len() % width != 0 {
        return Err(Error::new(Status::InvalidArg, format!("Expected {width} features per note.")));
    }
    Ok(AsyncTask::new(Refine { model, features: features.to_vec(), width, output, what }))
}

/// The pitch corrector (`notefix.onnx`) on 24 features per note: 5 probabilities per note, for
/// shifting it by -2, -1, 0, +1 and +2 semitones.
#[napi(ts_return_type = "Promise<Float32Array>")]
pub fn predict_pitch_shifts(model: String, features: Float32Array) -> Result<AsyncTask<Refine>> {
    refine(model, features, 24, "probabilities", "The pitch corrector")
}

/// The note-end regressor (`ends.onnx`) on 27 features per note: seconds to add to each note's end.
#[napi(ts_return_type = "Promise<Float32Array>")]
pub fn predict_note_ends(model: String, features: Float32Array) -> Result<AsyncTask<Refine>> {
    refine(model, features, 27, "variable", "The note-end model")
}
