//! Beats and downbeats: Beat This! (beat-this-onnx: the `final0` checkpoint, and its log-mel
//! spectrogram as a separate graph) over the whole song, in the chunks its own inference uses
//! (`beat_this.inference.split_predict_aggregate`: 1500 frames, 6 frames discarded at each edge,
//! the earlier chunk's prediction kept where chunks overlap). Peaks are picked in TypeScript.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use ort::value::Tensor;

use crate::runtime::{self, Device, ModelSource};

// Beat This! works at 22.05 kHz (the caller decodes at that rate) and predicts every 20 ms.
const BINS: usize = 128;
const CHUNK: usize = 1500;
const BORDER: usize = 6;

/// Beat and downbeat logits per 20 ms frame.
#[napi(object)]
pub struct BeatLogits {
    pub beat: Float32Array,
    pub downbeat: Float32Array,
}

/// `split_piece`'s chunk starts (frames; the first is negative: it is padded with zeros).
fn chunk_starts(frames: usize) -> Vec<isize> {
    let step = CHUNK - 2 * BORDER;
    let mut starts: Vec<isize> = (0..).map(|k| k as isize * step as isize - BORDER as isize).take_while(|&s| s < frames as isize - BORDER as isize).collect();
    if starts.is_empty() {
        starts.push(-(BORDER as isize));
    }
    // The last chunk ends at the end of the piece instead of running past it.
    if frames > step {
        *starts.last_mut().expect("at least one chunk") = frames as isize - (CHUNK - BORDER) as isize;
    }
    starts
}

pub struct Beats {
    logmel: String,
    model: String,
    samples: Vec<f32>,
}

impl Beats {
    fn run(&mut self) -> Result<(Vec<f32>, Vec<f32>)> {
        let failed = |error: String| Error::from_reason(format!("Finding the beat failed: {error}"));
        let mut logmel = runtime::session(ModelSource::File(&self.logmel), Device::Cpu, "The beat model's spectrogram")?;
        let samples = std::mem::take(&mut self.samples);
        let input = Tensor::from_array(([samples.len()], samples.into_boxed_slice())).map_err(|e| failed(e.to_string()))?;
        let outputs = logmel.run(ort::inputs!["audio" => input]).map_err(|e| failed(e.to_string()))?;
        let (shape, spect) = outputs["spect"].try_extract_tensor::<f32>().map_err(|e| failed(e.to_string()))?;
        let frames = shape[0] as usize;
        let spect = spect.to_vec();
        drop(outputs);

        let mut model = runtime::session(ModelSource::File(&self.model), Device::Cpu, "The beat model")?;
        let mut beat = vec![-1000.0f32; frames];
        let mut downbeat = vec![-1000.0f32; frames];
        let starts = chunk_starts(frames);
        // Later chunks first, so earlier ones overwrite where they overlap ("keep_first").
        for &start in starts.iter().rev() {
            let from = start.max(0) as usize;
            let to = ((start + CHUNK as isize) as usize).min(frames);
            let left = (-start).max(0) as usize;
            let right = (start + CHUNK as isize - frames as isize).clamp(0, BORDER as isize) as usize;
            let length = left + (to - from) + right;
            let mut chunk = vec![0.0f32; length * BINS];
            chunk[left * BINS..(left + to - from) * BINS].copy_from_slice(&spect[from * BINS..to * BINS]);
            let input = Tensor::from_array(([1usize, length, BINS], chunk.into_boxed_slice())).map_err(|e| failed(e.to_string()))?;
            let outputs = model.run(ort::inputs!["spect" => input]).map_err(|e| failed(e.to_string()))?;
            let (_, beats) = outputs["beat"].try_extract_tensor::<f32>().map_err(|e| failed(e.to_string()))?;
            let (_, downbeats) = outputs["downbeat"].try_extract_tensor::<f32>().map_err(|e| failed(e.to_string()))?;
            // Without the borders, written from start + BORDER on (clipped to the piece).
            let kept = length - 2 * BORDER;
            for k in 0..kept {
                let frame = start + (BORDER + k) as isize;
                if frame >= 0 && (frame as usize) < frames {
                    beat[frame as usize] = beats[BORDER + k];
                    downbeat[frame as usize] = downbeats[BORDER + k];
                }
            }
        }
        Ok((beat, downbeat))
    }
}

impl Task for Beats {
    type Output = (Vec<f32>, Vec<f32>);
    type JsValue = BeatLogits;

    fn compute(&mut self) -> Result<Self::Output> {
        self.run()
    }

    fn resolve(&mut self, _env: Env, (beat, downbeat): Self::Output) -> Result<Self::JsValue> {
        Ok(BeatLogits { beat: Float32Array::new(beat), downbeat: Float32Array::new(downbeat) })
    }
}

/// Beat and downbeat logits every 20 ms of a mono 22.05 kHz song, with the spectrogram model at
/// `logmel` and Beat This! at `model`. Runs on a worker thread.
#[napi(ts_return_type = "Promise<BeatLogits>")]
pub fn beat_logits(logmel: String, model: String, samples: Float32Array) -> Result<AsyncTask<Beats>> {
    if samples.len() < 2048 {
        return Err(Error::new(Status::InvalidArg, "The song is too short to find its beat."));
    }
    Ok(AsyncTask::new(Beats { logmel, model, samples: samples.to_vec() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_like_split_piece() {
        // Shorter than a chunk: one, padded at both ends.
        assert_eq!(chunk_starts(1000), vec![-6]);
        // Longer: every 1488 frames, the last moved to end at the end of the piece.
        assert_eq!(chunk_starts(4000), vec![-6, 1482, 4000 - 1494]);
    }
}
