/**
 * Beat and downbeat times from Beat This!'s frame logits (native `beatLogits`): its "minimal" postprocessing, a
 * port of `beat_this.model.postprocessor.Postprocessor.postp_minimal` and `deduplicate_peaks`.
 */

/** Beat This! predicts 50 frames per second. */
const FPS = 50;

/** Frames that are the largest within ±3 frames (max-pool 7) and above 0 (probability over 0.5). */
function peaks(logits: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < logits.length; i++) {
    let most = -Infinity;
    for (let k = Math.max(0, i - 3); k <= Math.min(logits.length - 1, i + 3); k++) most = Math.max(most, logits[k]!);
    if (logits[i] === most && logits[i]! > 0) out.push(i);
  }
  return out;
}

/** Groups of peaks at most `width` frames apart become their mean frame. */
function deduplicate(frames: number[], width = 1): number[] {
  const result: number[] = [];
  if (!frames.length) return result;
  let p = frames[0]!;
  let c = 1;
  for (const p2 of frames.slice(1)) {
    if (p2 - p <= width) {
      c += 1;
      p += (p2 - p) / c; // the running mean
    } else {
      result.push(p);
      p = p2;
      c = 1;
    }
  }
  result.push(p);
  return result;
}

/** Beat and downbeat times in seconds; each downbeat sits on its nearest beat. */
export function beatTimes(
  beat: Float32Array,
  downbeat: Float32Array,
): { beats: Float64Array; downbeats: Float64Array } {
  const beats = Float64Array.from(deduplicate(peaks(beat)), (f) => f / FPS);
  const moved = deduplicate(peaks(downbeat)).map((f) => {
    const t = f / FPS;
    if (!beats.length) return t;
    let nearest = 0;
    for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i]! - t) < Math.abs(beats[nearest]! - t)) nearest = i;
    return beats[nearest]!;
  });
  // np.unique: sorted, without repeats.
  const downbeats = Float64Array.from(new Set(moved)).toSorted();
  return { beats, downbeats };
}
