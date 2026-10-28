/**
 * Notes as tones (Web Audio): a short tone of a pitch while editing it, and the notes along with playback. Playback
 * tones are scheduled a little ahead on every frame, timed from where the audio is; a jump (seek, loop, a source
 * switch) or a pause stops them and the next frame starts again from there. Rap and freestyle notes have no pitch to
 * play.
 *
 * The song's time is what is heard (the audio element allows for the speakers' delay), but a tone is heard only the
 * context's latency after its scheduled time: a few ms on built-in speakers, a few hundred on Bluetooth. Tones are
 * scheduled that much earlier, as the context reports it on every frame (the output can change while playing). So
 * scheduling waits until the song's time moves (after starting or a seek it stays put until the first sound is
 * heard), and stops at a loop's end (a tone scheduled past it would already be on its way when the loop goes back).
 */
import type { NoteType } from "~/lib/native/types";

import { firstFrom, voiced } from "./chart";
import { midiToHz } from "./voice-pitch";

export interface ToneNote {
  id: number;
  start: number;
  duration: number;
  /** MIDI. */
  pitch: number;
  type: NoteType;
}

/** How far ahead tones are scheduled (seconds of real time). */
const LOOKAHEAD = 0.2;
/** A time further from the expected one than this is a jump (seconds). */
const JUMP = 0.3;
const PREVIEW_SECONDS = 0.25;
const VOLUME = 0.22;
/**
 * Sung notes are often around 100-300 Hz, which laptop speakers barely play: a sawtooth's overtones carry the pitch
 * (heard as the same note), softened by a low-pass so it doesn't buzz.
 */
const WAVE: OscillatorType = "sawtooth";
const BRIGHTNESS_HZ = 2200;

export function createTones(options: {
  /** The notes, sorted by start. A new array restarts scheduling (for example, after hiding a singer). */
  notes: () => readonly ToneNote[];
  /** Makes the audio context (on first use: browsers want it made after a user gesture). */
  context?: () => AudioContext;
}) {
  let context: AudioContext | null = null;
  let output: GainNode | null = null;
  /** How loud, 0-1 (of the tones' own level). */
  let volume = 1;
  const audio = () => {
    if (!context) {
      context = options.context?.() ?? new AudioContext();
      output = context.createGain();
      output.gain.value = VOLUME * volume;
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = BRIGHTNESS_HZ;
      output.connect(filter).connect(context.destination);
    }
    if (context.state === "suspended") void context.resume();
    return { context, output: output! };
  };

  const sounding = new Set<OscillatorNode>();
  /** A tone from `at` (context time) for `seconds`, with short fades so it doesn't click. */
  const tone = (midi: number, at: number, seconds: number) => {
    const { context: ctx, output: out } = audio();
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    oscillator.type = WAVE;
    oscillator.frequency.value = midiToHz(midi);
    const fade = Math.min(0.02, seconds / 4);
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(1, at + fade);
    envelope.gain.setValueAtTime(1, at + seconds - fade);
    envelope.gain.linearRampToValueAtTime(0, at + seconds);
    oscillator.connect(envelope).connect(out);
    oscillator.start(at);
    oscillator.stop(at + seconds);
    sounding.add(oscillator);
    oscillator.addEventListener("ended", () => {
      sounding.delete(oscillator);
      envelope.disconnect();
    });
  };

  /** Where playback tones are: the song time scheduled up to, and the time and context time of the last frame. */
  let scheduled: { until: number; time: number; at: number; notes: readonly ToneNote[] } | null = null;
  /** The last frame's time while waiting for the song's time to move. */
  let waiting: number | null = null;

  const stop = () => {
    for (const oscillator of sounding) oscillator.stop();
    sounding.clear();
    scheduled = null;
    waiting = null;
  };

  return {
    /** A short tone of `midi` (editing a note's pitch). */
    preview(midi: number) {
      tone(midi, audio().context.currentTime, PREVIEW_SECONDS);
    },

    /** A frame while playing at `rate`, the audio at `time`: schedules the notes coming up, none past `end`. */
    frame(time: number, rate: number, end = Number.POSITIVE_INFINITY) {
      const { context: ctx } = audio();
      const now = ctx.currentTime;
      const expected = scheduled ? scheduled.time + (now - scheduled.at) * rate : time;
      const notes = options.notes();
      if (scheduled && (Math.abs(time - expected) > JUMP || scheduled.notes !== notes)) stop();
      const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      /** When to start a sound for it to be heard as the song reaches `songTime`. */
      const startFor = (songTime: number) => now + (songTime - time) / rate - latency;
      /** A note's tone from when it should be heard; what is too late for that plays its rest at once. */
      const play = (note: ToneNote) => {
        const at = Math.max(now, startFor(note.start));
        const until = startFor(Math.min(note.start + note.duration, end));
        if (voiced(note.type) && until - at > 0.05) tone(note.pitch, at, until - at);
      };
      let from: number;
      if (!scheduled) {
        // Not heard yet: the song's time only moves once it is.
        if (waiting === null || time <= waiting) {
          waiting = time;
          return;
        }
        waiting = null;
        // Starting (or after a jump): notes already sounding play their rest.
        for (const note of notes) {
          if (note.start >= time) break;
          play(note);
        }
        from = time;
      } else from = scheduled.until;
      const until = Math.min(time + (LOOKAHEAD + latency) * rate, end);
      for (let i = firstFrom(notes, from); i < notes.length && notes[i]!.start < until; i++) play(notes[i]!);
      scheduled = { until: Math.max(until, from), time, at: now, notes };
    },

    /** How loud the tones are, 0-1. */
    setVolume(next: number) {
      volume = Math.min(1, Math.max(0, next));
      if (output) output.gain.value = VOLUME * volume;
    },

    /** Playback stopped, jumped or changed speed: the tones stop (the next frame starts again). */
    stop,

    dispose() {
      stop();
      void context?.close();
      context = null;
    },
  };
}

export type Tones = ReturnType<typeof createTones>;
