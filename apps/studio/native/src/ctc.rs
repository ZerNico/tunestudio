//! CTC forced alignment: the most likely path of a known text through the aligner's per-frame
//! log-probabilities. A port of ctc-forced-aligner's `forced_align_impl` (BSD 2-Clause, Copyright
//! (c) 2026 Mahmoud Ashraf, after flashlight's CTC criterion), kept in f32 with the same
//! comparisons and tie-breaks so the same emissions give the same path.

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// The aligner's CTC blank.
const BLANK: usize = 0;

/// Packed bits, two per (state, frame) in the band the path can use.
struct Bits(Vec<u64>);

impl Bits {
    fn new(count: usize) -> Self {
        Self(vec![0; count.div_ceil(64)])
    }
    fn set(&mut self, index: usize) {
        self.0[index / 64] |= 1 << (index % 64);
    }
    fn get(&self, index: usize) -> bool {
        self.0[index / 64] >> (index % 64) & 1 == 1
    }
}

/// The text can't fit in the frames: more letters (plus repeats) than frames.
#[derive(Debug, PartialEq)]
pub struct TooLong;

/// The label of each frame on the best path of `targets` through `log_probs` (`frames` rows of
/// `classes` log-probabilities; a target `classes` or above reads as a log-probability of 0, the
/// "<star>" column ctc-forced-aligner appends), and that label's log-probability per frame.
pub fn forced_align(log_probs: &[f32], frames: usize, classes: usize, targets: &[usize]) -> std::result::Result<(Vec<usize>, Vec<f32>), TooLong> {
    let lp = |t: usize, label: usize| if label < classes { log_probs[t * classes + label] } else { 0.0 };
    let t_len = frames;
    let l = targets.len();
    let s = 2 * l + 1;
    let repeats = (1..l).filter(|&i| targets[i] == targets[i - 1]).count();
    if t_len < l + repeats || t_len == 0 {
        return Err(TooLong);
    }
    let label = |i: usize| if i % 2 == 0 { BLANK } else { targets[i / 2] };
    let mut alphas = vec![f32::NEG_INFINITY; 2 * s];
    let mut offsets = vec![0usize; t_len.saturating_sub(1)];
    let mut seeks = vec![0usize; t_len.saturating_sub(1)];
    let band = (s + 1) * (t_len - l);
    let (mut bit0, mut bit1) = (Bits::new(band), Bits::new(band));

    let mut start = if t_len - (l + repeats) > 0 { 0 } else { 1 };
    let mut end = if s == 1 { 1 } else { 2 };
    for i in start..end {
        alphas[i] = lp(0, label(i));
    }
    let mut seek = 0usize;
    for t in 1..t_len {
        if t_len - t <= l + repeats {
            if start % 2 == 1 && targets[start / 2] != targets[start / 2 + 1] {
                start += 1;
            }
            start += 1;
        }
        if t <= l + repeats {
            if end % 2 == 0 && end < 2 * l && targets[end / 2 - 1] != targets[end / 2] {
                end += 1;
            }
            end += 1;
        }
        let mut startloop = start;
        let (current, previous) = ((t % 2) * s, ((t - 1) % 2) * s);
        alphas[current..current + s].fill(f32::NEG_INFINITY);
        seeks[t - 1] = seek;
        offsets[t - 1] = start;
        if start == 0 {
            alphas[current] = alphas[previous] + lp(t, BLANK);
            startloop += 1;
            seek += 1;
        }
        for i in startloop..end {
            let x0 = alphas[previous + i];
            let x1 = alphas[previous + i - 1];
            // Skipping a blank: only onto a letter, and not between two equal letters.
            let x2 = if i % 2 != 0 && i != 1 && targets[i / 2] != targets[i / 2 - 1] { alphas[previous + i - 2] } else { f32::NEG_INFINITY };
            let result = if x2 > x1 && x2 > x0 {
                bit1.set(seek + i - startloop);
                x2
            } else if x1 > x0 && x1 > x2 {
                bit0.set(seek + i - startloop);
                x1
            } else {
                x0
            };
            alphas[current + i] = result + lp(t, label(i));
        }
        seek += end - startloop;
    }
    let last = ((t_len - 1) % 2) * s;
    let mut state = if s == 1 || alphas[last + s - 1] > alphas[last + s - 2] { s - 1 } else { s - 2 };
    let mut path = vec![0usize; t_len];
    for t in (0..t_len).rev() {
        path[t] = label(state);
        // The first frame has no step to undo (the C++ reads past its bookkeeping there; the result
        // isn't used).
        if t > 0 {
            let index = seeks[t - 1] + state - offsets[t - 1];
            state -= (usize::from(bit1.get(index)) << 1) | usize::from(bit0.get(index));
        }
    }
    let scores = path.iter().enumerate().map(|(t, &label)| lp(t, label)).collect();
    Ok((path, scores))
}

/// The best path of a text through part of the aligner's emissions.
#[napi(object)]
pub struct AlignedPath {
    /// The label of each frame (vocabulary ids; the blank is 0).
    pub path: Int32Array,
    /// That label's log-probability per frame.
    pub scores: Float32Array,
}

pub struct ForcedAlign {
    emissions: Vec<f32>,
    classes: usize,
    targets: Vec<usize>,
}

impl Task for ForcedAlign {
    type Output = (Vec<usize>, Vec<f32>);
    type JsValue = AlignedPath;

    fn compute(&mut self) -> Result<Self::Output> {
        let frames = self.emissions.len() / self.classes;
        if self.targets.is_empty() {
            return Err(Error::new(Status::InvalidArg, "There is no text to align."));
        }
        forced_align(&self.emissions, frames, self.classes, &self.targets)
            .map_err(|_| Error::new(Status::InvalidArg, "The text is too long for this part of the song."))
    }

    fn resolve(&mut self, _env: Env, (path, scores): Self::Output) -> Result<Self::JsValue> {
        Ok(AlignedPath {
            path: Int32Array::new(path.into_iter().map(|label| label as i32).collect()),
            scores: Float32Array::new(scores),
        })
    }
}

/// Aligns `targets` (vocabulary ids; `classes` and above count as "<star>", log-probability 0)
/// to frames `from`..`to` of `emissions`, the aligner's log-probabilities with `classes` per
/// frame. Fails with InvalidArg when there's no text or it can't fit in those frames.
#[napi(ts_return_type = "Promise<AlignedPath>")]
pub fn forced_align_path(emissions: Float32Array, classes: u32, from: u32, to: u32, targets: Int32Array) -> Result<AsyncTask<ForcedAlign>> {
    let classes = classes as usize;
    let (from, to) = (from as usize * classes, (to as usize * classes).min(emissions.len()));
    if classes == 0 || from > to || targets.iter().any(|&t| t <= 0) {
        return Err(Error::new(Status::InvalidArg, "The alignment request is invalid."));
    }
    Ok(AsyncTask::new(ForcedAlign {
        emissions: emissions[from..to].to_vec(),
        classes,
        targets: targets.iter().map(|&t| t as usize).collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Log-probabilities from per-frame probabilities.
    fn logs(rows: &[&[f32]]) -> Vec<f32> {
        rows.iter().flat_map(|row| row.iter().map(|p| p.ln())).collect()
    }

    #[test]
    fn follows_the_likely_letters() {
        // Classes: blank, a, b. The text "a b" over 5 frames: a a blank b b.
        let probs = logs(&[&[0.1, 0.8, 0.1], &[0.1, 0.8, 0.1], &[0.8, 0.1, 0.1], &[0.1, 0.1, 0.8], &[0.1, 0.1, 0.8]]);
        let (path, scores) = forced_align(&probs, 5, 3, &[1, 2]).unwrap();
        assert_eq!(path, vec![1, 1, 0, 2, 2]);
        assert!((scores[0] - 0.8f32.ln()).abs() < 1e-6);
    }

    #[test]
    fn needs_a_blank_between_repeated_letters() {
        // "a a" in 3 frames must be a blank a; 2 frames are too few.
        let probs = logs(&[&[0.1, 0.9], &[0.1, 0.9], &[0.1, 0.9]]);
        assert_eq!(forced_align(&probs, 3, 2, &[1, 1]).unwrap().0, vec![1, 0, 1]);
        assert_eq!(forced_align(&probs[..4], 2, 2, &[1, 1]), Err(TooLong));
    }

    #[test]
    fn reads_targets_past_the_classes_as_certain() {
        // The "<star>" column ctc-forced-aligner appends: log-probability 0 everywhere.
        let probs = logs(&[&[0.9, 0.1], &[0.9, 0.1], &[0.1, 0.9]]);
        let (path, scores) = forced_align(&probs, 3, 2, &[2, 1]).unwrap();
        assert_eq!(path, vec![2, 2, 1]);
        assert_eq!(scores[0], 0.0);
    }
}
