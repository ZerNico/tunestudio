//! The vocals' harmonics over each note, for the octave fixes (electron/charting/song.ts
//! `fixOctaves`): log10(odd / even harmonic energy) for the octave below and for the note's own
//! pitch. If the voice really sits an octave lower, the odd harmonics of that lower pitch are
//! strong (they don't exist an octave up); if the note is an octave too low, its odd harmonics are
//! weak. A port of the auto-tuner PoC's `chart._harmonics` (NumPy's rfft, in f64).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use realfft::RealFftPlanner;

const N: usize = 4096;
const HOP: usize = 1024;

/// One note: its start and end in seconds and its MIDI pitch.
#[napi(object)]
pub struct NoteSpan {
    pub start: f64,
    pub end: f64,
    pub midi: f64,
}

/// For each note, [down, up], or NaN for both when the note is too short to measure.
fn ratios(samples: &[f32], sr: f64, notes: &[NoteSpan]) -> Vec<f64> {
    let mut planner = RealFftPlanner::<f64>::new();
    let fft = planner.plan_fft_forward(N);
    // np.hanning: symmetric.
    let window: Vec<f64> = (0..N).map(|k| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * k as f64 / (N - 1) as f64).cos()).collect();
    let freqs: Vec<f64> = (0..=N / 2).map(|k| k as f64 * sr / N as f64).collect();
    let (mut input, mut spectrum) = (fft.make_input_vec(), fft.make_output_vec());
    let mut out = Vec::with_capacity(notes.len() * 2);
    for note in notes {
        let (i, j) = ((note.start * sr) as usize, (note.end * sr) as usize);
        let starts: Vec<usize> = (i..(i + 1).max(j.saturating_sub(N))).step_by(HOP).filter(|t| t + N <= samples.len()).collect();
        if starts.is_empty() {
            out.extend([f64::NAN, f64::NAN]);
            continue;
        }
        let mut power = vec![0.0f64; N / 2 + 1];
        for &t in &starts {
            for k in 0..N {
                input[k] = f64::from(samples[t + k]) * window[k];
            }
            fft.process(&mut input, &mut spectrum).expect("fft sizes match");
            // np.abs(...) ** 2: through the magnitude, as NumPy rounds it.
            for (p, c) in power.iter_mut().zip(&spectrum) {
                *p += c.re.hypot(c.im).powi(2);
            }
        }
        for p in power.iter_mut() {
            *p /= starts.len() as f64;
        }
        let energy = |f0: f64, harmonics: std::ops::Range<u32>| -> f64 {
            let mut e = 0.0;
            for k in harmonics.step_by(2) {
                let f = f64::from(k) * f0;
                if f > 5000.0 {
                    break;
                }
                let c = freqs.partition_point(|&x| x < f);
                e += power[c.saturating_sub(2)..(c + 3).min(power.len())].iter().copied().fold(f64::NEG_INFINITY, f64::max);
            }
            e + 1e-12
        };
        let low = 440.0 * 2f64.powf((note.midi - 12.0 - 69.0) / 12.0);
        let own = 440.0 * 2f64.powf((note.midi - 69.0) / 12.0);
        out.push((energy(low, 1..16) / energy(low, 2..17)).log10());
        out.push((energy(own, 1..12) / energy(own, 2..13)).log10());
    }
    out
}

pub struct Harmonics {
    samples: Vec<f32>,
    notes: Vec<NoteSpan>,
}

impl Task for Harmonics {
    type Output = Vec<f64>;
    type JsValue = Float64Array;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(ratios(&self.samples, 44_100.0, &self.notes))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(Float64Array::new(output))
    }
}

/// [down, up] per note (NaN, NaN for a note too short to measure) over mono 44.1 kHz vocals.
/// Runs on a worker thread.
#[napi(ts_return_type = "Promise<Float64Array>")]
pub fn harmonic_ratios(samples: Float32Array, notes: Vec<NoteSpan>) -> AsyncTask<Harmonics> {
    AsyncTask::new(Harmonics { samples: samples.to_vec(), notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hears_which_octave_a_tone_is_in() {
        // A220 with all its harmonics: a note at A3 (MIDI 57) has strong odd harmonics; one written
        // an octave too high (A4, MIDI 69) finds the "octave below" pattern instead.
        let sr = 44_100.0;
        let samples: Vec<f32> = (0..sr as usize)
            .map(|i| (1..20).map(|k| (2.0 * std::f64::consts::PI * 220.0 * k as f64 * i as f64 / sr).sin() / k as f64).sum::<f64>() as f32)
            .collect();
        let at = |midi: f64| ratios(&samples, sr, &[NoteSpan { start: 0.1, end: 0.9, midi }]);
        let a3 = at(57.0);
        let a4 = at(69.0);
        assert!(a4[0] > a3[0], "the octave below A4 is A3, where the voice is: {a3:?} vs {a4:?}");
        // Past the end of the audio there is nothing to measure.
        assert!(ratios(&samples, sr, &[NoteSpan { start: 0.99, end: 1.2, midi: 60.0 }])[0].is_nan());
    }
}
