//! Notes from the vocals with GAME (openvpi's Generative Adaptive MIDI Extractor, its released ONNX
//! models): per line of lyrics, the audio and the durations of the regions between syllable starts
//! go in, notes (start, end, sung or not, pitch) come out. The segmenter samples which boundaries
//! to keep (a D3PM, 8 steps); its random op is replaced by an input fed from NumPy's generator,
//! seeded per line, as the auto-tuner PoC does (`game.py`), so the same line gives the same notes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use ort::session::Session;
use ort::value::Tensor;

use crate::numpy_rng::Generator;
use crate::runtime::{self, Device, ModelSource};

/// GAME works at 44.1 kHz.
pub const SAMPLE_RATE: usize = 44_100;
const STEPS: usize = 8;

type ProgressCallback = ThreadsafeFunction<u32, (), u32, Status, false, true>;

// --- The segmenter's random op as an input, on the ONNX protobuf directly. ---

fn read_varint(bytes: &[u8], at: &mut usize) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*at)?;
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// One protobuf field: its number, wire type, raw bytes (tag included) and, for length-delimited
/// fields, the payload.
struct Field<'a> {
    number: u64,
    raw: &'a [u8],
    payload: Option<&'a [u8]>,
}

fn fields(bytes: &[u8]) -> Option<Vec<Field<'_>>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let start = at;
        let tag = read_varint(bytes, &mut at)?;
        let payload = match tag & 7 {
            0 => {
                read_varint(bytes, &mut at)?;
                None
            }
            1 => {
                at += 8;
                None
            }
            2 => {
                let length = read_varint(bytes, &mut at)? as usize;
                let payload = bytes.get(at..at + length)?;
                at += length;
                Some(payload)
            }
            5 => {
                at += 4;
                None
            }
            _ => return None,
        };
        out.push(Field { number: tag >> 3, raw: bytes.get(start..at)?, payload });
    }
    Some(out)
}

fn length_delimited(out: &mut Vec<u8>, number: u64, payload: &[u8]) {
    write_varint(out, number << 3 | 2);
    write_varint(out, payload.len() as u64);
    out.extend_from_slice(payload);
}

/// A float graph input of shape [B, T] named `name` (an ONNX ValueInfoProto).
fn noise_input(name: &str) -> Vec<u8> {
    let mut shape = Vec::new();
    for dim in ["B", "T"] {
        let mut dimension = Vec::new();
        length_delimited(&mut dimension, 2, dim.as_bytes());
        length_delimited(&mut shape, 1, &dimension);
    }
    let mut tensor = vec![1 << 3, 1]; // elem_type: FLOAT
    length_delimited(&mut tensor, 2, &shape);
    let mut kind = Vec::new();
    length_delimited(&mut kind, 1, &tensor);
    let mut info = Vec::new();
    length_delimited(&mut info, 1, name.as_bytes());
    length_delimited(&mut info, 2, &kind);
    info
}

/// The segmenter without its RandomUniformLike node: the node's output becomes a graph input of the
/// same name, which `noise` names. Everything else (the weights too) is copied as it is.
fn patch_segmenter(model: &[u8]) -> Option<(Vec<u8>, String)> {
    let mut out = Vec::with_capacity(model.len() + 64);
    let mut noise = None;
    for field in fields(model)? {
        if field.number != 7 {
            out.extend_from_slice(field.raw);
            continue;
        }
        // GraphProto: node = 1, input = 11.
        let mut graph = Vec::with_capacity(field.payload?.len() + 64);
        for part in fields(field.payload?)? {
            if part.number == 1 {
                // NodeProto: output = 2, op_type = 4.
                let node = fields(part.payload?)?;
                let op = node.iter().find(|f| f.number == 4).and_then(|f| f.payload);
                if op == Some(b"RandomUniformLike".as_slice()) {
                    let output = node.iter().find(|f| f.number == 2).and_then(|f| f.payload)?;
                    noise = Some(String::from_utf8(output.to_vec()).ok()?);
                    continue;
                }
            }
            graph.extend_from_slice(part.raw);
        }
        let name = noise.clone()?;
        length_delimited(&mut graph, 11, &noise_input(&name));
        length_delimited(&mut out, 7, &graph);
    }
    Some((out, noise?))
}

// --- Inference. ---

/// One line's audio and known regions.
#[napi(object)]
pub struct GameRequest {
    /// The line's audio: samples `from`..`to` of the vocals.
    pub from: u32,
    pub to: u32,
    /// Durations (seconds) of the regions whose boundaries GAME must keep, summing to the audio's length.
    pub known: Vec<f64>,
}

/// GAME's notes for every request, flattened: request k has `counts[k]` notes, in order.
#[napi(object)]
pub struct GameNotes {
    pub counts: Vec<u32>,
    /// Seconds from the start of the request's audio.
    pub starts: Float64Array,
    pub ends: Float64Array,
    /// 1 where the note is sung.
    pub voiced: Uint8Array,
    /// Fractional MIDI pitch.
    pub midi: Float64Array,
}

pub struct Game {
    folder: String,
    samples: Vec<f32>,
    requests: Vec<(usize, usize, Vec<f64>)>,
    language: i64,
    on_progress: Option<Arc<ProgressCallback>>,
    cancelled: Arc<AtomicBool>,
}

struct Sessions {
    encoder: Session,
    segmenter: Session,
    estimator: Session,
    dur2bd: Session,
    bd2dur: Session,
    noise: String,
}

type Notes = Vec<(f64, f64, bool, f64)>;

impl Game {
    fn sessions(&self) -> Result<Sessions> {
        let path = |name: &str| format!("{}/{name}.onnx", self.folder);
        let load = |name: &str| runtime::session(ModelSource::File(&path(name)), Device::Cpu, "The note model");
        let bytes = std::fs::read(path("segmenter")).map_err(|error| Error::from_reason(format!("The note model couldn't be read: {error}")))?;
        let (patched, noise) = patch_segmenter(&bytes).ok_or_else(|| Error::from_reason("The note model's segmenter isn't the expected one."))?;
        drop(bytes);
        Ok(Sessions {
            encoder: load("encoder")?,
            segmenter: runtime::session(ModelSource::Bytes(&patched), Device::Cpu, "The note model")?,
            estimator: load("estimator")?,
            dur2bd: load("dur2bd")?,
            bd2dur: load("bd2dur")?,
            noise,
        })
    }

    /// `game.Game.extract` for one line.
    fn extract(&self, s: &mut Sessions, waveform: &[f32], known: &[f64]) -> Result<Notes> {
        let failed = |error: String| Error::from_reason(format!("Finding the notes failed: {error}"));
        let e = |error: ort::Error| failed(error.to_string());
        let duration = waveform.len() as f64 / SAMPLE_RATE as f64;
        let wav = Tensor::from_array(([1usize, waveform.len()], waveform.to_vec().into_boxed_slice())).map_err(e)?;
        let dur = Tensor::from_array(([1usize], vec![duration as f32].into_boxed_slice())).map_err(e)?;
        let encoded = s.encoder.run(ort::inputs!["waveform" => wav, "duration" => dur]).map_err(e)?;
        let (seg_shape, x_seg) = encoded["x_seg"].try_extract_tensor::<f32>().map_err(e)?;
        let (est_shape, x_est) = encoded["x_est"].try_extract_tensor::<f32>().map_err(e)?;
        let (_, mask_t) = encoded["maskT"].try_extract_tensor::<bool>().map_err(e)?;
        let (seg_shape, x_seg) = (seg_shape.iter().map(|&d| d as usize).collect::<Vec<_>>(), x_seg.to_vec());
        let (est_shape, x_est) = (est_shape.iter().map(|&d| d as usize).collect::<Vec<_>>(), x_est.to_vec());
        let mask_t = mask_t.to_vec();
        drop(encoded);
        let frames = mask_t.len();
        let mask = || Tensor::from_array(([1usize, frames], mask_t.clone().into_boxed_slice()));

        let known: Vec<f32> = if known.is_empty() { vec![duration as f32] } else { known.iter().map(|&d| d as f32).collect() };
        let mut known_bd = if known.len() > 1 {
            let durations = Tensor::from_array(([1usize, known.len()], known.into_boxed_slice())).map_err(e)?;
            let out = s.dur2bd.run(ort::inputs!["durations" => durations, "maskT" => mask().map_err(e)?]).map_err(e)?;
            let (_, bd) = out["boundaries"].try_extract_tensor::<bool>().map_err(e)?;
            bd.to_vec()
        } else {
            // One region has no inner boundaries.
            vec![false; frames]
        };
        for (bd, m) in known_bd.iter_mut().zip(&mask_t) {
            *bd = *bd && *m;
        }

        let mut rng = Generator::new(0);
        let mut bd = known_bd.clone();
        let step = 1.0 / STEPS as f64;
        for i in 0..STEPS {
            let inputs = ort::inputs![
                "x_seg" => Tensor::from_array((seg_shape.clone(), x_seg.clone().into_boxed_slice())).map_err(e)?,
                "language" => Tensor::from_array(([1usize], vec![self.language].into_boxed_slice())).map_err(e)?,
                "known_boundaries" => Tensor::from_array(([1usize, frames], known_bd.clone().into_boxed_slice())).map_err(e)?,
                "prev_boundaries" => Tensor::from_array(([1usize, frames], bd.clone().into_boxed_slice())).map_err(e)?,
                "t" => Tensor::from_array(([1usize], vec![(i as f64 * step) as f32].into_boxed_slice())).map_err(e)?,
                "maskT" => mask().map_err(e)?,
                "threshold" => Tensor::from_array((Vec::<usize>::new(), vec![0.2f32].into_boxed_slice())).map_err(e)?,
                "radius" => Tensor::from_array((Vec::<usize>::new(), vec![2i64].into_boxed_slice())).map_err(e)?,
                s.noise.as_str() => Tensor::from_array(([1usize, frames], rng.floats(frames).into_boxed_slice())).map_err(e)?,
            ];
            let out = s.segmenter.run(inputs).map_err(e)?;
            let (_, next) = out["boundaries"].try_extract_tensor::<bool>().map_err(e)?;
            bd = next.to_vec();
        }

        let out = s.bd2dur.run(ort::inputs![
            "boundaries" => Tensor::from_array(([1usize, frames], bd.clone().into_boxed_slice())).map_err(e)?,
            "maskT" => mask().map_err(e)?,
        ]).map_err(e)?;
        let (_, durations) = out["durations"].try_extract_tensor::<f32>().map_err(e)?;
        let (n_shape, mask_n) = out["maskN"].try_extract_tensor::<bool>().map_err(e)?;
        let (durations, mask_n, notes) = (durations.to_vec(), mask_n.to_vec(), n_shape[1] as usize);
        drop(out);
        let out = s.estimator.run(ort::inputs![
            "x_est" => Tensor::from_array((est_shape, x_est.into_boxed_slice())).map_err(e)?,
            "boundaries" => Tensor::from_array(([1usize, frames], bd.into_boxed_slice())).map_err(e)?,
            "maskT" => mask().map_err(e)?,
            "maskN" => Tensor::from_array(([1usize, notes], mask_n.clone().into_boxed_slice())).map_err(e)?,
            "threshold" => Tensor::from_array((Vec::<usize>::new(), vec![0.2f32].into_boxed_slice())).map_err(e)?,
        ]).map_err(e)?;
        let (_, presence) = out["presence"].try_extract_tensor::<bool>().map_err(e)?;
        let (_, scores) = out["scores"].try_extract_tensor::<f32>().map_err(e)?;

        let mut result = Vec::new();
        let mut t = 0.0f64;
        for k in 0..notes {
            if !mask_n[k] {
                break;
            }
            let d = f64::from(durations[k]);
            result.push((t, t + d, presence[k], f64::from(scores[k])));
            t += d;
        }
        Ok(result)
    }
}

impl Task for Game {
    type Output = Vec<Notes>;
    type JsValue = GameNotes;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut sessions = self.sessions()?;
        let mut out = Vec::with_capacity(self.requests.len());
        for (index, (from, to, known)) in self.requests.iter().enumerate() {
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(Error::new(Status::Cancelled, "Finding the notes was cancelled."));
            }
            out.push(self.extract(&mut sessions, &self.samples[*from..*to], known)?);
            if let Some(on_progress) = &self.on_progress {
                on_progress.call(((index + 1) * 100 / self.requests.len()) as u32, ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
        Ok(out)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let notes = output.iter().flatten();
        Ok(GameNotes {
            counts: output.iter().map(|line| line.len() as u32).collect(),
            starts: Float64Array::new(notes.clone().map(|n| n.0).collect()),
            ends: Float64Array::new(notes.clone().map(|n| n.1).collect()),
            voiced: Uint8Array::new(notes.clone().map(|n| u8::from(n.2)).collect()),
            midi: Float64Array::new(notes.map(|n| n.3).collect()),
        })
    }
}

/// GAME's notes for each line: `folder` holds its ONNX files (encoder, segmenter, estimator,
/// dur2bd, bd2dur), `samples` the mono 44.1 kHz vocals, `language` its language id (0 for
/// universal). Runs on a worker thread, reporting the percentage of lines done; aborting `signal`
/// stops it between lines.
#[napi(ts_return_type = "Promise<GameNotes>")]
pub fn transcribe_notes(
    folder: String,
    samples: Float32Array,
    requests: Vec<GameRequest>,
    language: i64,
    #[napi(ts_arg_type = "(percent: number) => void")] on_progress: Option<ProgressCallback>,
    signal: Option<AbortSignal>,
) -> Result<AsyncTask<Game>> {
    let total = samples.len();
    let requests = requests
        .into_iter()
        .map(|r| {
            let (from, to) = (r.from as usize, r.to as usize);
            if from >= to || to > total {
                return Err(Error::new(Status::InvalidArg, "A note request is outside the vocals."));
            }
            Ok((from, to, r.known))
        })
        .collect::<Result<Vec<_>>>()?;
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = &signal {
        let flag = cancelled.clone();
        signal.on_abort(move || flag.store(true, Ordering::Relaxed));
    }
    Ok(AsyncTask::with_optional_signal(
        Game { folder, samples: samples.to_vec(), requests, language, on_progress: on_progress.map(Arc::new), cancelled },
        signal,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A NodeProto with these inputs, outputs and op type.
    fn node(inputs: &[&str], outputs: &[&str], op: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for input in inputs {
            length_delimited(&mut out, 1, input.as_bytes());
        }
        for output in outputs {
            length_delimited(&mut out, 2, output.as_bytes());
        }
        length_delimited(&mut out, 4, op.as_bytes());
        out
    }

    #[test]
    fn replaces_the_random_op_by_an_input() {
        let mut graph = Vec::new();
        length_delimited(&mut graph, 1, &node(&["like"], &["noise_out"], "RandomUniformLike"));
        length_delimited(&mut graph, 1, &node(&["noise_out", "x"], &["y"], "Less"));
        length_delimited(&mut graph, 5, b"weights stay as they are");
        let mut model = vec![1 << 3, 8]; // ir_version 8
        length_delimited(&mut model, 7, &graph);

        let (patched, noise) = patch_segmenter(&model).unwrap();
        assert_eq!(noise, "noise_out");
        let top = fields(&patched).unwrap();
        assert_eq!(top[0].raw, &[8, 8]);
        let parts = fields(top[1].payload.unwrap()).unwrap();
        assert_eq!(parts.iter().map(|p| p.number).collect::<Vec<_>>(), vec![1, 5, 11]);
        assert_eq!(parts[0].payload.unwrap(), node(&["noise_out", "x"], &["y"], "Less").as_slice());
        let input = fields(parts[2].payload.unwrap()).unwrap();
        assert_eq!(input[0].payload.unwrap(), b"noise_out");
    }
}
