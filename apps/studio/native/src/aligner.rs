//! The lyrics aligner (tunestudio-aligner: MMS fine-tuned on singing) and the syllable-start head
//! on top of it. One pass over the vocals gives the CTC log-probabilities every 20 ms, which the
//! forced alignment (ctc.rs) reads, and the hidden states the head turns into the probability that
//! a syllable starts in each frame. The windows match ctc-forced-aligner's `generate_emissions`:
//! 30 s with 2 s of context on each side.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use ort::value::Tensor;

use crate::runtime::{self, Device, ModelSource};

/// The aligner works at 16 kHz and outputs a frame every 320 samples.
pub const SAMPLE_RATE: usize = 16_000;
const RATIO: usize = 320;
const WINDOW: usize = 30 * SAMPLE_RATE;
const CONTEXT: usize = 2 * SAMPLE_RATE;
/// Letters and marks the aligner knows (its vocabulary, without the "<star>" ctc-forced-aligner adds).
pub const CLASSES: usize = 31;
const HIDDEN: usize = 1024;

type ProgressCallback = ThreadsafeFunction<u32, (), u32, Status, false, true>;

/// The aligner's view of a song.
#[napi(object)]
pub struct AlignerOutputs {
    /// Log-probabilities of the aligner's 31 classes per 20 ms frame (frames × 31).
    pub emissions: Float32Array,
    /// The number of frames.
    pub frames: u32,
    /// Per frame, the probability that a syllable starts there.
    pub syllable_starts: Float32Array,
}

/// The windows the song is run in: (start sample of each, in the padded song), the padded song, the
/// context frames to drop at each window's start, and the frames to drop at the end.
fn windows(samples: &[f32]) -> (Vec<f32>, Vec<usize>, usize, usize) {
    if samples.len() < WINDOW {
        return (samples.to_vec(), vec![0], 0, 0);
    }
    let extension = samples.len().div_ceil(WINDOW) * WINDOW - samples.len();
    let mut padded = vec![0.0f32; CONTEXT];
    padded.extend_from_slice(samples);
    padded.resize(padded.len() + CONTEXT + extension, 0.0);
    let starts = (0..(samples.len() + extension) / WINDOW).map(|k| k * WINDOW).collect();
    // ctc-forced-aligner drops `extension // 320` frames at the end with `[: -n]`, which keeps no
    // frames at all when the extension is under one frame; here those songs keep all of them.
    (padded, starts, CONTEXT / RATIO, extension / RATIO)
}

/// `torch.log_softmax` over each frame's classes, in f32.
fn log_softmax(row: &mut [f32]) {
    let max = row.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let sum: f32 = row.iter().map(|x| (x - max).exp()).sum();
    let log = sum.ln();
    for x in row.iter_mut() {
        *x = *x - max - log;
    }
}

pub struct Align {
    aligner: String,
    boundary: String,
    samples: Vec<f32>,
    on_progress: Option<Arc<ProgressCallback>>,
    cancelled: Arc<AtomicBool>,
}

impl Align {
    fn run(&self) -> Result<(Vec<f32>, Vec<f32>, usize)> {
        let failed = |error: String| Error::from_reason(format!("Timing the lyrics failed: {error}"));
        let mut aligner = runtime::session(ModelSource::File(&self.aligner), Device::Cpu, "The lyrics aligner")?;
        let (padded, starts, context, drop_end) = windows(&self.samples);
        let span = if starts.len() == 1 && context == 0 { padded.len() } else { WINDOW + 2 * CONTEXT };
        let keep = WINDOW / RATIO;
        let (mut emissions, mut hidden) = (Vec::new(), Vec::new());
        for (index, &start) in starts.iter().enumerate() {
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(Error::new(Status::Cancelled, "Timing the lyrics was cancelled."));
            }
            let chunk = padded[start..start + span].to_vec();
            let input = Tensor::from_array(([1usize, span], chunk.into_boxed_slice())).map_err(|e| failed(e.to_string()))?;
            let outputs = aligner.run(ort::inputs!["audio" => input]).map_err(|e| failed(e.to_string()))?;
            let (shape, logits) = outputs["logits"].try_extract_tensor::<f32>().map_err(|e| failed(e.to_string()))?;
            let (_, states) = outputs["hidden"].try_extract_tensor::<f32>().map_err(|e| failed(e.to_string()))?;
            let frames = shape[1] as usize;
            // Without context (a song under 30 s) every frame counts.
            let (from, to) = if context == 0 { (0, frames) } else { (context, (context + keep).min(frames)) };
            emissions.extend_from_slice(&logits[from * CLASSES..to * CLASSES]);
            hidden.extend_from_slice(&states[from * HIDDEN..to * HIDDEN]);
            if let Some(on_progress) = &self.on_progress {
                on_progress.call(((index + 1) * 90 / starts.len()) as u32, ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
        let frames = emissions.len() / CLASSES - drop_end;
        emissions.truncate(frames * CLASSES);
        hidden.truncate(frames * HIDDEN);
        for row in emissions.chunks_mut(CLASSES) {
            log_softmax(row);
        }
        // The head reads the whole song at once (a bidirectional GRU).
        drop(aligner);
        let mut boundary = runtime::session(ModelSource::File(&self.boundary), Device::Cpu, "The syllable model")?;
        let input = Tensor::from_array(([1usize, frames, HIDDEN], hidden.into_boxed_slice())).map_err(|e| failed(e.to_string()))?;
        let outputs = boundary.run(ort::inputs!["hidden" => input]).map_err(|e| failed(e.to_string()))?;
        let (_, probs) = outputs["probs"].try_extract_tensor::<f32>().map_err(|e| failed(e.to_string()))?;
        Ok((emissions, probs.to_vec(), frames))
    }
}

impl Task for Align {
    type Output = (Vec<f32>, Vec<f32>, usize);
    type JsValue = AlignerOutputs;

    fn compute(&mut self) -> Result<Self::Output> {
        self.run()
    }

    fn resolve(&mut self, _env: Env, (emissions, starts, frames): Self::Output) -> Result<Self::JsValue> {
        Ok(AlignerOutputs { emissions: Float32Array::new(emissions), frames: frames as u32, syllable_starts: Float32Array::new(starts) })
    }
}

/// The aligner (`aligner.onnx`) and syllable-start head (`boundary.onnx`) over a mono 16 kHz vocal
/// track. Runs on a worker thread, reporting the percentage done; aborting `signal` stops it
/// between windows.
#[napi(ts_return_type = "Promise<AlignerOutputs>")]
pub fn aligner_outputs(
    aligner: String,
    boundary: String,
    samples: Float32Array,
    #[napi(ts_arg_type = "(percent: number) => void")] on_progress: Option<ProgressCallback>,
    signal: Option<AbortSignal>,
) -> AsyncTask<Align> {
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = &signal {
        let flag = cancelled.clone();
        signal.on_abort(move || flag.store(true, Ordering::Relaxed));
    }
    AsyncTask::with_optional_signal(
        Align { aligner, boundary, samples: samples.to_vec(), on_progress: on_progress.map(Arc::new), cancelled },
        signal,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_like_generate_emissions() {
        // Under 30 s: one window, no context.
        let (padded, starts, context, drop_end) = windows(&vec![0.1; 10 * SAMPLE_RATE]);
        assert_eq!((padded.len(), starts, context, drop_end), (10 * SAMPLE_RATE, vec![0], 0, 0));
        // 70 s: three windows of 30 s plus 2 s of context each side; the 20 s of padding at the end
        // are 1000 frames to drop.
        let (padded, starts, context, drop_end) = windows(&vec![0.1; 70 * SAMPLE_RATE]);
        assert_eq!(padded.len(), 90 * SAMPLE_RATE + 2 * CONTEXT);
        assert_eq!((starts, context, drop_end), (vec![0, WINDOW, 2 * WINDOW], 100, 1000));
    }

    #[test]
    fn log_softmax_sums_to_one() {
        let mut row = [1.0f32, 2.0, 3.0];
        log_softmax(&mut row);
        assert!((row.iter().map(|x| x.exp()).sum::<f32>() - 1.0).abs() < 1e-6);
    }
}
