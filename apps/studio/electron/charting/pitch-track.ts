/**
 * The singer's pitch track: FCPE's pitch (native `trackPitch`, Hz every 10 ms) as fractional MIDI notes, with the
 * vocals' loudness per frame. A port of the auto-tuner PoC's `pitch.track` and `pitch.loudness`; the PoC keeps both
 * in float32, so this does too.
 */
import { pairwiseSum } from "./numpy";
import type { PitchTrack } from "./refiners";

/** The vocals' sample rate for the pitch model and the loudness. */
export const PITCH_SAMPLE_RATE = 16_000;
/** One frame every 10 ms. */
export const HOP_SECONDS = 0.01;
const HOP = 160;
const WINDOW = 400;

export interface FullPitchTrack extends PitchTrack {
  /** Loudness in dB per frame (25 ms windows). */
  rms: Float32Array;
}

/** MIDI per frame from FCPE's Hz (0 = unvoiced, NaN in the track). */
export function midiFromHz(f0: Float32Array): Float32Array {
  return f0.map((hz) =>
    hz > 0 ? Math.fround(69 + Math.fround(12 * Math.fround(Math.log2(Math.fround(hz / 440))))) : Number.NaN,
  );
}

/** RMS in dB per 10 ms frame over a 25 ms window, aligned with the pitch frames (16 kHz audio). */
export function loudness(audio: Float32Array, frames: number): Float32Array {
  // np.pad(audio, (200, 400)) and frame indexes clamped to the padded end.
  const padded = new Float32Array(WINDOW / 2 + audio.length + WINDOW);
  padded.set(audio, WINDOW / 2);
  const squares = new Float32Array(WINDOW);
  const floor = Math.fround(1e-10);
  const out = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    for (let k = 0; k < WINDOW; k++) {
      const x = padded[Math.min(frame * HOP + k, padded.length - 1)]!;
      squares[k] = Math.fround(x * x);
    }
    const mean = Math.fround(pairwiseSum(squares, 0, WINDOW, Math.fround) / WINDOW);
    out[frame] = Math.fround(10 * Math.fround(Math.log10(Math.fround(mean + floor))));
  }
  return out;
}

/** The pitch track from FCPE's output and the 16 kHz vocals it ran on. */
export function pitchTrack(f0: Float32Array, audio: Float32Array): FullPitchTrack {
  return {
    times: Float64Array.from(f0, (_, i) => i * HOP_SECONDS),
    midi: midiFromHz(f0),
    rms: loudness(audio, f0.length),
  };
}
