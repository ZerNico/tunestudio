/**
 * Scrubbing: while the playhead is dragged, the selected source is heard where it is, a short grain at a time (Web
 * Audio, from the file decoded on the first drag and kept until another file is scrubbed; one that fails is tried
 * again on the next drag). Moving on plays the next grain; holding still repeats a longer stretch from there, so a
 * syllable can be heard whole.
 */

/** A drag's grains: how long each sounds, and its fades so it doesn't click (seconds). */
const GRAIN = 0.09;
const FADE = 0.01;
/** At most one grain this often (ms): a fast drag skips the times in between. */
const EVERY_MS = 45;
/** Held this long without a move (ms), the playhead starts repeating where it is. */
const HOLD_MS = 120;
/** The held stretch (seconds), and how often it starts (ms). */
const LOOP = 0.04;
const LOOP_EVERY_MS = 60;

async function fetchAndDecode(url: string, context: AudioContext): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't load ${url}: ${response.status}`);
  return context.decodeAudioData(await response.arrayBuffer());
}

export function createScrub(options: {
  /** The file of the source playing now (none: nothing to hear). */
  url: () => string | undefined;
  /** Makes the audio context (on first use: browsers want it made after a user gesture). */
  context?: () => AudioContext;
  /** Loads and decodes a file. */
  load?: (url: string, context: AudioContext) => Promise<AudioBuffer>;
  /** The time now (ms), for the grains' pace. */
  now?: () => number;
}) {
  const load = options.load ?? fetchAndDecode;
  const now = options.now ?? (() => performance.now());
  let context: AudioContext | null = null;
  let output: GainNode | null = null;
  /** How loud, 0-1 (the song's volume). */
  let volume = 1;
  /** The file decoded or being decoded, and the result once it is in (null: it couldn't be). */
  let decoded: { url: string; buffer: AudioBuffer | null } | null = null;
  let sounding: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  let lastGrain = -Infinity;
  /** A grain held back to keep the pace: the latest time asked for. */
  let waiting: { seconds: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Repeating a held playhead's stretch, or waiting to start. */
  let holding: ReturnType<typeof setTimeout> | null = null;

  const audio = () => {
    if (!context) {
      context = options.context?.() ?? new AudioContext();
      output = context.createGain();
      output.gain.value = volume;
      output.connect(context.destination);
    }
    if (context.state === "suspended") void context.resume();
    return { context, output: output! };
  };

  /** The selected source's samples, once decoded; starts decoding them the first time. */
  const buffer = () => {
    const url = options.url();
    if (!url) return null;
    if (decoded?.url !== url) {
      const loading = { url, buffer: null as AudioBuffer | null };
      decoded = loading;
      load(url, audio().context).then(
        (result) => void (loading.buffer = result),
        (error: unknown) => {
          console.warn("Couldn't decode the audio to scrub", error);
          if (decoded === loading) decoded = null;
        },
      );
    }
    return decoded.buffer;
  };

  /** Fades out the grain sounding now. */
  const quiet = () => {
    if (!sounding || !context) return;
    const at = context.currentTime;
    sounding.gain.gain.cancelScheduledValues(at);
    sounding.gain.gain.setValueAtTime(sounding.gain.gain.value, at);
    sounding.gain.gain.linearRampToValueAtTime(0, at + FADE);
    sounding.source.stop(at + FADE);
    sounding = null;
  };

  /** Plays from `seconds`; false if there is nothing to hear there (yet). */
  const grain = (seconds: number, length = GRAIN) => {
    const samples = buffer();
    if (!samples || seconds < 0 || seconds >= samples.duration) return false;
    lastGrain = now();
    quiet();
    const { context, output } = audio();
    const at = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = samples;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(1, at + FADE);
    gain.gain.setValueAtTime(1, at + length - FADE);
    gain.gain.linearRampToValueAtTime(0, at + length);
    source.connect(gain).connect(output);
    source.start(at, seconds, length);
    const playing = { source, gain };
    sounding = playing;
    source.addEventListener("ended", () => {
      if (sounding === playing) sounding = null;
    });
    return true;
  };

  const stopHolding = () => {
    if (holding) clearTimeout(holding);
    holding = null;
  };

  const cancelWaiting = () => {
    if (waiting) clearTimeout(waiting.timer);
    waiting = null;
    stopHolding();
  };

  /** A grain at `seconds`, then, if the playhead stays there, the stretch from there over and over. */
  const grainThenHold = (seconds: number) => {
    if (!grain(seconds)) return;
    const repeat = () => {
      grain(seconds, LOOP);
      holding = setTimeout(repeat, LOOP_EVERY_MS);
    };
    holding = setTimeout(repeat, HOLD_MS);
  };

  return {
    /** The playhead is at `seconds`: a grain from there, now or (to keep the pace) soon; repeated if it stays. */
    at: (seconds: number) => {
      // The source may have changed since the last grain: its decoding starts now, whatever the pace.
      buffer();
      stopHolding();
      const wait = lastGrain + EVERY_MS - now();
      if (wait <= 0) {
        cancelWaiting();
        grainThenHold(seconds);
      } else if (waiting) waiting.seconds = seconds;
      else {
        const timer = setTimeout(() => {
          const next = waiting!.seconds;
          waiting = null;
          grainThenHold(next);
        }, wait);
        waiting = { seconds, timer };
      }
    },
    /** The drag is over: quiet at once. */
    end: () => {
      cancelWaiting();
      quiet();
    },
    setVolume: (next: number) => {
      volume = Math.min(1, Math.max(0, next));
      if (output) output.gain.value = volume;
    },
    dispose: () => {
      cancelWaiting();
      quiet();
      void context?.close();
      context = null;
      output = null;
      decoded = null;
    },
  };
}

export type Scrub = ReturnType<typeof createScrub>;
