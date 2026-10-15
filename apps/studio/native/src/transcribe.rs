//! Whisper (whisper.cpp through whisper-rs): what is sung, as text with timestamps.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

/// whisper.cpp asks this between steps; `user_data` points at the task's cancel flag.
unsafe extern "C" fn abort_requested(user_data: *mut std::ffi::c_void) -> bool {
    (*(user_data as *const AtomicBool)).load(Ordering::Relaxed)
}

/// Where one stretch's progress goes: the share of the whole song before it and its own.
struct StretchProgress {
    callback: Arc<ProgressCallback>,
    before: usize,
    length: usize,
    total: usize,
}

/// whisper.cpp reports a stretch's progress here; `user_data` points at its `StretchProgress`.
unsafe extern "C" fn progress_made(
    _context: *mut whisper_rs::WhisperSysContext,
    _state: *mut whisper_rs::WhisperSysState,
    percent: std::os::raw::c_int,
    user_data: *mut std::ffi::c_void,
) {
    let progress = &*(user_data as *const StretchProgress);
    let heard = progress.before + progress.length * percent.clamp(0, 100) as usize / 100;
    progress.callback.call((heard * 100 / progress.total) as u32, ThreadsafeFunctionCallMode::NonBlocking);
}

/// Sample rate Whisper expects.
pub const SAMPLE_RATE: u32 = 16_000;

/// One stretch of speech or singing Whisper heard.
#[napi(object)]
pub struct TranscriptSegment {
    /// Seconds from the start.
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// ISO 639-1 code of the language it was heard in.
    pub language: String,
    /// How sure Whisper is of the words, on average (0 to 1): low for words it made up from noise.
    pub confidence: f64,
}

/// What Whisper heard in a song.
#[napi(object)]
pub struct Transcript {
    /// ISO 639-1 code of the language it heard, e.g. "de".
    pub language: String,
    pub segments: Vec<TranscriptSegment>,
}

/// A stretch of the audio, in seconds.
#[napi(object)]
pub struct TimeRange {
    pub start: f64,
    pub end: f64,
}

#[napi(object)]
pub struct TranscribeOptions {
    /// ISO 639-1 code, or none to detect it.
    pub language: Option<String>,
    /// Threads for the parts that run on the CPU; defaults to what whisper.cpp picks.
    pub threads: Option<u32>,
    /// Only these stretches, each transcribed on its own (where something is sung, at most 30 s
    /// each); the whole audio when missing.
    pub ranges: Option<Vec<TimeRange>>,
    /// Sung in several languages: each stretch is heard in the language it sounds like, when
    /// Whisper is fairly sure, and in the song's main language otherwise.
    pub mixed: Option<bool>,
}

/// In a song with several languages, a stretch needs at least this probability for its own.
const OWN_LANGUAGE: f32 = 0.5;

/// How many stretches vote on the language, longest first.
const LANGUAGE_VOTES: usize = 6;
/// Whisper hears 30 s at a time.
const WINDOW: usize = 30 * SAMPLE_RATE as usize;

/// Called with the percentage done (0–100) as Whisper works through the song.
type ProgressCallback = ThreadsafeFunction<u32, (), u32, Status, false, true>;

pub struct Transcribe {
    model: String,
    samples: Vec<f32>,
    options: TranscribeOptions,
    on_progress: Option<Arc<ProgressCallback>>,
    cancelled: Arc<AtomicBool>,
}

/// The mean probability of a segment's text tokens (not timestamps or other special tokens).
fn confidence(segment: &whisper_rs::WhisperSegment) -> f64 {
    let mut sum = 0.0;
    let mut count = 0;
    for index in 0..segment.n_tokens() {
        let Some(token) = segment.get_token(index) else { continue };
        let special = token.to_str_lossy().map(|text| text.starts_with("[_") || text.starts_with("<|")).unwrap_or(true);
        if !special {
            sum += token.token_probability() as f64;
            count += 1;
        }
    }
    if count == 0 { 0.0 } else { sum / count as f64 }
}

impl Transcribe {
    fn threads(&self) -> usize {
        self.options.threads.map(|threads| threads as usize).unwrap_or_else(|| {
            std::thread::available_parallelism().map(|count| count.get().min(8)).unwrap_or(4)
        })
    }

    /// The stretches to transcribe, as sample ranges within the audio.
    fn ranges(&self) -> Vec<(usize, usize)> {
        let length = self.samples.len();
        let at = |seconds: f64| ((seconds.max(0.0) * SAMPLE_RATE as f64) as usize).min(length);
        match &self.options.ranges {
            Some(ranges) => ranges
                .iter()
                .map(|range| (at(range.start), at(range.end)))
                .filter(|(start, end)| end > start)
                .collect(),
            None => vec![(0, length)],
        }
    }

    /// How likely each language is in a stretch, from its first 30 s.
    fn language_probabilities(&self, state: &mut WhisperState, (start, end): (usize, usize)) -> Result<Vec<f32>> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::new(Status::Cancelled, "Listening was cancelled."));
        }
        let window = &self.samples[start..end.min(start + WINDOW)];
        state
            .pcm_to_mel(window, self.threads())
            .map_err(|error| Error::from_reason(format!("Listening to the song failed: {error}")))?;
        let (_, probabilities) = state
            .lang_detect(0, self.threads())
            .map_err(|error| Error::from_reason(format!("Recognizing the language failed: {error}")))?;
        Ok(probabilities)
    }

    /// The language most of the longest stretches sound like. Whisper decides from the first
    /// 30 s it hears, and a song's intro or a featured verse can be in another language, so
    /// several stretches add up their probabilities.
    fn detect_language(&self, state: &mut WhisperState, ranges: &[(usize, usize)]) -> Result<String> {
        let mut longest = ranges.to_vec();
        longest.sort_by_key(|(start, end)| std::cmp::Reverse(end - start));
        let mut votes: Vec<f32> = Vec::new();
        for range in longest.into_iter().take(LANGUAGE_VOTES) {
            let probabilities = self.language_probabilities(state, range)?;
            if votes.is_empty() {
                votes = vec![0.0; probabilities.len()];
            }
            for (vote, probability) in votes.iter_mut().zip(probabilities) {
                *vote += probability;
            }
        }
        Ok(language_code(most_likely(&votes).0))
    }
}

/// The most likely language's id and its probability.
fn most_likely(probabilities: &[f32]) -> (i32, f32) {
    probabilities
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(id, probability)| (id as i32, *probability))
        .unwrap_or((0, 0.0))
}

fn language_code(id: i32) -> String {
    whisper_rs::get_lang_str(id).unwrap_or("en").to_string()
}

impl Task for Transcribe {
    type Output = Transcript;
    type JsValue = Transcript;

    fn compute(&mut self) -> Result<Self::Output> {
        let context = WhisperContext::new_with_params(&self.model, WhisperContextParameters::default())
            .map_err(|error| Error::from_reason(format!("The listening model couldn't be loaded: {error}")))?;
        let mut state = context
            .create_state()
            .map_err(|error| Error::from_reason(format!("The listening model couldn't start: {error}")))?;

        let ranges = self.ranges();
        let mixed = self.options.mixed.unwrap_or(false);
        let language = match &self.options.language {
            Some(language) if !mixed => language.clone(),
            _ if ranges.is_empty() => "en".to_string(),
            _ => self.detect_language(&mut state, &ranges)?,
        };

        let total: usize = ranges.iter().map(|(start, end)| end - start).sum::<usize>().max(1);
        let mut done = 0usize;
        let mut segments = Vec::new();
        for (start, end) in ranges {
            let heard_in = if mixed {
                let (id, probability) = most_likely(&self.language_probabilities(&mut state, (start, end))?);
                if probability >= OWN_LANGUAGE { language_code(id) } else { language.clone() }
            } else {
                language.clone()
            };
            let mut params = FullParams::new(SamplingStrategy::BeamSearch { beam_size: 5, patience: -1.0 });
            params.set_language(Some(&heard_in));
            params.set_n_threads(self.threads() as i32);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_special(false);
            params.set_print_timestamps(false);
            // Each sentence on its own, not run on from the last: songs repeat lines, and carrying the
            // previous text over makes Whisper repeat itself where the song doesn't.
            params.set_no_context(true);
            params.set_suppress_blank(true);
            // No "♪" or "(music)" for the instrumental bits.
            params.set_suppress_nst(true);

            // Not `set_progress_callback_safe`: it leaks its boxed closure (and with it the
            // callback) on every call. This one lives until `full` returns, then drops.
            let progress = self.on_progress.clone().map(|callback| StretchProgress {
                callback,
                before: done,
                length: end - start,
                total,
            });
            if let Some(progress) = &progress {
                unsafe {
                    params.set_progress_callback(Some(progress_made));
                    params.set_progress_callback_user_data(progress as *const StretchProgress as *mut std::ffi::c_void);
                }
            }
            // whisper-rs's `set_abort_callback_safe` reads its closure back as the wrong type (it
            // stores `Box<Box<dyn FnMut>>` but the trampoline casts to `F`), so whisper.cpp sees
            // garbage and aborts at random. Our own trampoline reads the flag this task owns, which
            // lives until `full` returns.
            unsafe {
                params.set_abort_callback(Some(abort_requested));
                params.set_abort_callback_user_data(Arc::as_ptr(&self.cancelled) as *mut std::ffi::c_void);
            }

            let result = state.full(params, &self.samples[start..end]);
            // A cancelled run ends with whisper.cpp's generic failure code.
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(Error::new(Status::Cancelled, "Listening was cancelled."));
            }
            result.map_err(|error| Error::from_reason(format!("Listening to the song failed: {error}")))?;

            let offset = start as f64 / SAMPLE_RATE as f64;
            for segment in state.as_iter() {
                let text = segment.to_str_lossy().map(|text| text.trim().to_string()).unwrap_or_default();
                if text.is_empty() {
                    continue;
                }
                // whisper.cpp counts in hundredths of a second.
                segments.push(TranscriptSegment {
                    start: offset + segment.start_timestamp() as f64 / 100.0,
                    end: offset + segment.end_timestamp() as f64 / 100.0,
                    text,
                    language: heard_in.clone(),
                    confidence: confidence(&segment),
                });
            }
            done += end - start;
        }
        Ok(Transcript { language, segments })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Writes down what is sung in `samples` (mono, 16 kHz) with the ggml Whisper model at
/// `model`: the whole audio or `options.ranges`, in `options.language` or the language most of
/// it is in. Runs on a worker thread; aborting `signal` stops it within a moment.
#[napi(ts_return_type = "Promise<Transcript>")]
pub fn transcribe(
    model: String,
    samples: Float32Array,
    options: TranscribeOptions,
    #[napi(ts_arg_type = "(percent: number) => void")] on_progress: Option<ProgressCallback>,
    signal: Option<AbortSignal>,
) -> AsyncTask<Transcribe> {
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Some(signal) = &signal {
        let flag = cancelled.clone();
        signal.on_abort(move || flag.store(true, Ordering::Relaxed));
    }
    AsyncTask::with_optional_signal(
        Transcribe {
            model,
            samples: samples.to_vec(),
            options,
            on_progress: on_progress.map(Arc::new),
            cancelled,
        },
        signal,
    )
}

/// The sample rate `transcribe` expects.
#[napi]
pub fn transcribe_sample_rate() -> u32 {
    SAMPLE_RATE
}
