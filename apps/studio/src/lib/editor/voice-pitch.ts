/**
 * The pitch of a short stretch of the microphone, for singing along: YIN (de Cheveigné and Kawahara, 2002), which finds
 * the period a sound repeats at. Quiet stretches and ones without a clear period (breaths, consonants) have none. A
 * sung pitch is folded to the octave of the note it is sung on, as the games do, so singing an octave lower is on it.
 * Also MIDI and Hz both ways (the notes' tones play from MIDI).
 */

/** Sung voices: from about E2 to C6. */
const LOWEST_HZ = 80;
const HIGHEST_HZ = 1050;
/** How clearly the stretch must repeat (YIN's threshold: lower is stricter). */
const CLARITY = 0.15;
/** Quieter than this (RMS) is silence. */
const QUIET = 0.01;

/** The normalized differences, kept between calls (this runs every frame). */
let scratch = new Float32Array(0);

/** The pitch (Hz) of `samples`, or null where nothing clear is sung. */
export function detectPitch(samples: Float32Array, sampleRate: number): number | null {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  if (Math.sqrt(energy / samples.length) < QUIET) return null;
  const shortest = Math.floor(sampleRate / HIGHEST_HZ);
  const longest = Math.min(Math.floor(sampleRate / LOWEST_HZ), Math.floor(samples.length / 2));
  if (longest <= shortest) return null;
  const window = samples.length - longest;
  if (scratch.length < longest + 1) scratch = new Float32Array(longest + 1);
  const normalized = scratch;
  // The difference of the stretch with itself `lag` samples later, normalized by its running mean. The first dip
  // under `CLARITY` is the period: once past its bottom, longer lags aren't needed.
  normalized[0] = 1;
  let running = 0;
  let dip = -1;
  let last = longest;
  for (let lag = 1; lag <= longest; lag++) {
    let difference = 0;
    for (let i = 0; i < window; i++) {
      const delta = samples[i]! - samples[i + lag]!;
      difference += delta * delta;
    }
    running += difference;
    normalized[lag] = running === 0 ? 1 : (difference * lag) / running;
    if (dip < 0) {
      if (lag >= shortest && normalized[lag]! < CLARITY) dip = lag;
    } else if (normalized[lag]! < normalized[dip]!) dip = lag;
    else {
      last = lag;
      break;
    }
  }
  if (dip < 0) return null;
  // The bottom of that dip, refined between samples.
  const before = normalized[dip - 1]!;
  const at = normalized[dip]!;
  const after = dip + 1 <= last ? normalized[dip + 1]! : at;
  const curve = before + after - 2 * at;
  const exact = curve > 0 ? dip + (before - after) / (2 * curve) : dip;
  return sampleRate / exact;
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/** `midi` moved by whole octaves to be as near `target` as it can. */
export function foldOctave(midi: number, target: number): number {
  return midi + 12 * Math.round((target - midi) / 12);
}
