//! Vocal separation with Mel-Band RoFormer (Kimberley Jensen's vocals model, exported to ONNX):
//! the song's vocals, as audio. The model works on spectrograms; the STFT and iSTFT around it
//! and the chunking match the reference implementation (Music-Source-Separation-Training's
//! `demix()`, with less overlap), so the output matches the original checkpoint's. It runs on
//! the GPU through WebGPU (Metal, Direct3D 12 or Vulkan; DirectML on Windows on ARM), and on the
//! CPU when there is none or it fails.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use ort::session::{builder::AutoDevicePolicy, Session};
use ort::value::Tensor;
use realfft::num_complex::Complex32;
use realfft::RealFftPlanner;

/// The sample rate the model works at.
pub const SAMPLE_RATE: u32 = 44_100;
const N_FFT: usize = 2048;
const HOP: usize = 441;
const BINS: usize = N_FFT / 2 + 1;
/// One model run: 8 s.
const CHUNK: usize = 352_800;
const FRAMES: usize = CHUNK / HOP + 1;
/// Chunks start every 6 s and are crossfaded over 0.8 s. The reference's 4 s takes half as long
/// again for no audible difference.
const STEP: usize = CHUNK * 3 / 4;
const FADE: usize = CHUNK / 10;

/// Separated stereo audio at 44.1 kHz.
#[napi(object)]
pub struct Stems {
    pub vocals_left: Float32Array,
    pub vocals_right: Float32Array,
    /// Where the model ran.
    #[napi(ts_type = "'gpu' | 'cpu'")]
    pub device: String,
    /// Why the GPU wasn't used, when it was tried and failed.
    pub gpu_problem: Option<String>,
}

#[napi(object)]
pub struct SeparateOptions {
    /// Run on the CPU only, instead of the GPU.
    pub cpu_only: Option<bool>,
}

type ProgressCallback = ThreadsafeFunction<u32, (), u32, Status, false, true>;

/// ONNX Runtime's process-wide environment, created on first use.
fn environment() -> Result<&'static ort::environment::Environment> {
    static ENVIRONMENT: OnceLock<std::result::Result<ort::environment::Environment, String>> = OnceLock::new();
    ENVIRONMENT
        .get_or_init(|| ort::init().with_name("tunestudio").build().map_err(|error| error.to_string()))
        .as_ref()
        .map_err(|error| Error::from_reason(format!("The model runtime couldn't start: {error}")))
}

pub struct Separate {
    model: String,
    left: Vec<f32>,
    right: Vec<f32>,
    cpu_only: bool,
    on_progress: Option<Arc<ProgressCallback>>,
    cancelled: Arc<AtomicBool>,
}

/// torch.hann_window(N_FFT): the periodic Hann window.
fn hann() -> Vec<f32> {
    (0..N_FFT)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / N_FFT as f32).cos())
        .collect()
}

/// `signal` mirrored at both ends by `pad` samples (numpy's "reflect", without repeating the edge).
fn reflect(signal: &[f32], pad: usize) -> Vec<f32> {
    let n = signal.len();
    let mut out = Vec::with_capacity(n + 2 * pad);
    for i in (1..=pad).rev() {
        out.push(signal[i.min(n - 1)]);
    }
    out.extend_from_slice(signal);
    for i in 0..pad {
        out.push(signal[n.saturating_sub(2 + i)]);
    }
    out
}

struct Spectral {
    forward: Arc<dyn realfft::RealToComplex<f32>>,
    inverse: Arc<dyn realfft::ComplexToReal<f32>>,
    window: Vec<f32>,
}

impl Spectral {
    fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        Self { forward: planner.plan_fft_forward(N_FFT), inverse: planner.plan_fft_inverse(N_FFT), window: hann() }
    }

    /// torch.stft(center=True, pad_mode="reflect", unnormalized): [frame][bin].
    fn stft(&self, chunk: &[f32]) -> Vec<Vec<Complex32>> {
        let padded = reflect(chunk, N_FFT / 2);
        let mut input = self.forward.make_input_vec();
        let mut output = self.forward.make_output_vec();
        (0..FRAMES)
            .map(|frame| {
                let start = frame * HOP;
                for (i, value) in input.iter_mut().enumerate() {
                    *value = padded[start + i] * self.window[i];
                }
                self.forward.process(&mut input, &mut output).expect("fft sizes match");
                output.clone()
            })
            .collect()
    }

    /// torch.istft(center=True, length=CHUNK): overlap-add with the squared window as envelope.
    fn istft(&self, frames: &[Vec<Complex32>]) -> Vec<f32> {
        let total = N_FFT + HOP * (FRAMES - 1);
        let mut signal = vec![0.0f32; total];
        let mut envelope = vec![0.0f32; total];
        let mut spectrum = self.inverse.make_input_vec();
        let mut output = self.inverse.make_output_vec();
        for (frame, bins) in frames.iter().enumerate() {
            spectrum.copy_from_slice(bins);
            // A real signal's spectrum has no imaginary part at 0 and Nyquist.
            spectrum[0].im = 0.0;
            spectrum[BINS - 1].im = 0.0;
            self.inverse.process(&mut spectrum, &mut output).expect("fft sizes match");
            let start = frame * HOP;
            for i in 0..N_FFT {
                signal[start + i] += output[i] / N_FFT as f32 * self.window[i];
                envelope[start + i] += self.window[i] * self.window[i];
            }
        }
        let offset = N_FFT / 2;
        (0..CHUNK)
            .map(|i| {
                let e = envelope[offset + i];
                if e > 1e-11 { signal[offset + i] / e } else { 0.0 }
            })
            .collect()
    }
}

/// The crossfade weights for one chunk: linear in and out over FADE samples.
fn chunk_window(first: bool, last: bool) -> Vec<f32> {
    let mut window = vec![1.0f32; CHUNK];
    if !first {
        for i in 0..FADE {
            window[i] = i as f32 / (FADE - 1) as f32;
        }
    }
    if !last {
        for i in 0..FADE {
            window[CHUNK - FADE + i] = 1.0 - i as f32 / (FADE - 1) as f32;
        }
    }
    window
}

/// The GPU runtime ort ships for this system, if any (`gpu` comes from build.rs).
fn gpu_provider() -> Option<ort::ep::ExecutionProviderDispatch> {
    #[cfg(gpu = "webgpu")]
    return Some(ort::ep::WebGPU::default().build().error_on_failure());
    #[cfg(gpu = "directml")]
    return Some(ort::ep::DirectML::default().build().error_on_failure());
    #[allow(unreachable_code)]
    None
}

impl Separate {
    fn session(&self, gpu: bool) -> Result<Session> {
        fn failed<R>(error: ort::Error<R>) -> Error {
            Error::from_reason(format!("The separation model couldn't be loaded: {error}"))
        }
        let builder = Session::builder(environment()?).map_err(failed)?;
        let mut builder = if gpu {
            let provider = gpu_provider().ok_or_else(|| Error::from_reason("No GPU runtime for this system."))?;
            builder.with_execution_providers([provider]).map_err(failed)?
        } else {
            // ort's default device policy picks Core ML on macOS even with only the CPU
            // registered (pykeio/ort#662), and Core ML can't run this model.
            builder.with_auto_device(AutoDevicePolicy::PreferCPU).map_err(failed)?
        };
        builder.commit_from_file(&self.model).map_err(failed)
    }

    /// One 8 s chunk of both channels through the model: the vocals of that chunk.
    fn run_chunk(&self, session: &mut Session, spectral: &Spectral, left: &[f32], right: &[f32]) -> Result<[Vec<f32>; 2]> {
        let specs = [spectral.stft(left), spectral.stft(right)];
        // [1, 4, BINS, FRAMES]: L re, L im, R re, R im.
        let mut data = vec![0.0f32; 4 * BINS * FRAMES];
        for (channel, spec) in specs.iter().enumerate() {
            for (frame, bins) in spec.iter().enumerate() {
                for (bin, value) in bins.iter().enumerate() {
                    data[((channel * 2) * BINS + bin) * FRAMES + frame] = value.re;
                    data[((channel * 2 + 1) * BINS + bin) * FRAMES + frame] = value.im;
                }
            }
        }
        fn failed<R>(error: ort::Error<R>) -> Error {
            Error::from_reason(format!("Separating the voice failed: {error}"))
        }
        let input = Tensor::from_array(([1usize, 4, BINS, FRAMES], data.into_boxed_slice())).map_err(failed)?;
        let outputs = session.run(ort::inputs!["mix_spec" => input]).map_err(failed)?;
        let (_, out) = outputs["stems_spec"].try_extract_tensor::<f32>().map_err(failed)?;
        let channel = |c: usize| -> Vec<Vec<Complex32>> {
            (0..FRAMES)
                .map(|frame| {
                    (0..BINS)
                        .map(|bin| {
                            Complex32::new(out[((c * 2) * BINS + bin) * FRAMES + frame], out[((c * 2 + 1) * BINS + bin) * FRAMES + frame])
                        })
                        .collect()
                })
                .collect()
        };
        Ok([spectral.istft(&channel(0)), spectral.istft(&channel(1))])
    }

    /// The whole song (`left` and `right` padded by `offset` at both ends) through the model, on
    /// the GPU or the CPU: `length` samples of vocals per channel.
    fn separate(&self, gpu: bool, left: &[f32], right: &[f32], offset: usize, length: usize) -> Result<(Vec<f32>, Vec<f32>)> {
        let mut session = self.session(gpu)?;
        let spectral = Spectral::new();
        stitch(
            left,
            right,
            offset,
            length,
            |left, right| {
                if self.cancelled.load(Ordering::Relaxed) {
                    return Err(Error::new(Status::Cancelled, "Separating the voice was cancelled."));
                }
                self.run_chunk(&mut session, &spectral, left, right)
            },
            |percent| {
                if let Some(on_progress) = &self.on_progress {
                    on_progress.call(percent, ThreadsafeFunctionCallMode::NonBlocking);
                }
            },
        )
    }
}

/// Runs `model` over the song in overlapping chunks and crossfades the results: `left` and
/// `right` are padded by `offset` at both ends, the result is the `length` samples between.
/// `progress` hears the percentage done after each chunk.
fn stitch(
    left: &[f32],
    right: &[f32],
    offset: usize,
    length: usize,
    mut model: impl FnMut(&[f32], &[f32]) -> Result<[Vec<f32>; 2]>,
    mut progress: impl FnMut(u32),
) -> Result<(Vec<f32>, Vec<f32>)> {
    let total = left.len();
    let mut result = [vec![0.0f32; total], vec![0.0f32; total]];
    let mut weight = vec![0.0f32; total];
    let starts: Vec<usize> = (0..total).step_by(STEP).collect();
    for (index, &start) in starts.iter().enumerate() {
        let end = (start + CHUNK).min(total);
        let piece = |signal: &[f32]| {
            let mut part = signal[start..end].to_vec();
            part.resize(CHUNK, 0.0);
            part
        };
        let vocals = model(&piece(left), &piece(right))?;
        let window = chunk_window(start == 0, start + CHUNK >= total);
        for i in 0..(end - start) {
            result[0][start + i] += vocals[0][i] * window[i];
            result[1][start + i] += vocals[1][i] * window[i];
            weight[start + i] += window[i];
        }
        progress(((index + 1) * 100 / starts.len()) as u32);
    }
    // Weighted, without the padding, in place: the song is held as few times as possible.
    let [mut vocals_left, mut vocals_right] = result;
    for channel in [&mut vocals_left, &mut vocals_right] {
        for i in 0..length {
            let w = weight[offset + i];
            channel[i] = if w > 0.0 { channel[offset + i] / w } else { 0.0 };
        }
        channel.truncate(length);
    }
    Ok((vocals_left, vocals_right))
}

/// The song mirrored at both ends, so its edges sit in the middle of a chunk (when it is long
/// enough to mirror): the padded channels and the padding.
fn pad(left: Vec<f32>, right: Vec<f32>) -> (Vec<f32>, Vec<f32>, usize) {
    let border = CHUNK - STEP;
    if left.len() > 2 * border {
        (reflect(&left, border), reflect(&right, border), border)
    } else {
        (left, right, 0)
    }
}

impl Task for Separate {
    type Output = ((Vec<f32>, Vec<f32>), &'static str, Option<String>);
    type JsValue = Stems;

    fn compute(&mut self) -> Result<Self::Output> {
        // The padded copy replaces the input rather than adding to it.
        let length = self.left.len();
        let (left, right, offset) = pad(std::mem::take(&mut self.left), std::mem::take(&mut self.right));
        let mut gpu_problem = None;
        if !self.cpu_only {
            match self.separate(true, &left, &right, offset, length) {
                Ok(vocals) => return Ok((vocals, "gpu", None)),
                Err(error) if error.status == Status::Cancelled => return Err(error),
                // No usable GPU, or its driver failed: the CPU is slower but works everywhere.
                Err(error) => gpu_problem = Some(error.reason.clone()),
            }
        }
        Ok((self.separate(false, &left, &right, offset, length)?, "cpu", gpu_problem))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let ((left, right), device, gpu_problem) = output;
        Ok(Stems {
            vocals_left: Float32Array::new(left),
            vocals_right: Float32Array::new(right),
            device: device.to_string(),
            gpu_problem,
        })
    }
}

/// Separates the vocals from a stereo song at 44.1 kHz with the ONNX model at `model`.
/// Runs on a worker thread, reporting the percentage done; aborting `signal` stops it
/// between chunks.
#[napi(ts_return_type = "Promise<Stems>")]
pub fn separate_vocals(
    model: String,
    left: Float32Array,
    right: Float32Array,
    options: SeparateOptions,
    #[napi(ts_arg_type = "(percent: number) => void")] on_progress: Option<ProgressCallback>,
    signal: Option<AbortSignal>,
) -> AsyncTask<Separate> {
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = &signal {
        let flag = cancelled.clone();
        signal.on_abort(move || flag.store(true, Ordering::Relaxed));
    }
    AsyncTask::with_optional_signal(
        Separate {
            model,
            left: left.to_vec(),
            right: right.to_vec(),
            cpu_only: options.cpu_only.unwrap_or(false),
            on_progress: on_progress.map(Arc::new),
            cancelled,
        },
        signal,
    )
}

/// The sample rate `separateVocals` works at, for its input and output.
#[napi]
pub fn separation_sample_rate() -> u32 {
    SAMPLE_RATE
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A song-like test signal: a few tones with a slow swell.
    fn signal(length: usize, seed: f32) -> Vec<f32> {
        (0..length)
            .map(|i| {
                let t = i as f32 / SAMPLE_RATE as f32;
                let swell = 0.5 + 0.5 * (t * 0.7 + seed).sin();
                swell * (0.3 * (t * 440.0 * 6.283).sin() + 0.2 * (t * 1234.5 * 6.283 + seed).sin())
            })
            .collect()
    }

    fn worst_difference(a: &[f32], b: &[f32]) -> f32 {
        assert_eq!(a.len(), b.len());
        a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
    }

    #[test]
    fn stft_then_istft_gives_the_chunk_back() {
        let spectral = Spectral::new();
        let chunk = signal(CHUNK, 0.3);
        let back = spectral.istft(&spectral.stft(&chunk));
        assert!(worst_difference(&chunk, &back) < 1e-4);
    }

    #[test]
    fn stitching_a_model_that_changes_nothing_gives_the_song_back() {
        // Long enough to be mirrored, short enough to be one chunk, and ragged lengths in between.
        for length in [44_100 * 3, CHUNK + 12_345, 44_100 * 41 + 7] {
            let (left, right) = (signal(length, 0.1), signal(length, 1.7));
            let (padded_left, padded_right, offset) = pad(left.clone(), right.clone());
            let mut percents = Vec::new();
            let (out_left, out_right) = stitch(
                &padded_left,
                &padded_right,
                offset,
                length,
                |l, r| Ok([l.to_vec(), r.to_vec()]),
                |percent| percents.push(percent),
            )
            .unwrap();
            assert!(worst_difference(&left, &out_left) < 1e-5, "left differs for {length} samples");
            assert!(worst_difference(&right, &out_right) < 1e-5, "right differs for {length} samples");
            assert_eq!(percents.last(), Some(&100));
        }
    }

    #[test]
    fn reflect_mirrors_like_numpy() {
        assert_eq!(reflect(&[1.0, 2.0, 3.0, 4.0], 2), vec![3.0, 2.0, 1.0, 2.0, 3.0, 4.0, 3.0, 2.0]);
    }
}
