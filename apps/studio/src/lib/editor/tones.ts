/**
 * Notes as tones (Web Audio): a short tone of a pitch while editing it, and the notes along with playback. Playback
 * tones are scheduled a little ahead on every frame, timed from where the audio is; a jump (seek, loop, a source
 * switch) or a pause stops them and the next frame starts again from there. Rap and freestyle notes have no pitch to
 * play.
 */
import type { NoteType } from "~/lib/native/types";

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
const VOLUME = 0.14;

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

const voiced = (type: NoteType) => type === "normal" || type === "golden";

/** The first index whose note starts at or after `time` (notes sorted by start). */
function firstFrom(notes: readonly ToneNote[], time: number): number {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (notes[middle]!.start < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function createTones(options: {
  /** The notes, sorted by start. */
  notes: () => readonly ToneNote[];
  /** Makes the audio context (on first use: browsers want it made after a user gesture). */
  context?: () => AudioContext;
}) {
  let context: AudioContext | null = null;
  let output: GainNode | null = null;
  const audio = () => {
    if (!context) {
      context = options.context?.() ?? new AudioContext();
      output = context.createGain();
      output.gain.value = VOLUME;
      output.connect(context.destination);
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
    oscillator.type = "triangle";
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
  let scheduled: { until: number; time: number; at: number } | null = null;

  const stop = () => {
    for (const oscillator of sounding) oscillator.stop();
    sounding.clear();
    scheduled = null;
  };

  return {
    /** A short tone of `midi` (editing a note's pitch). */
    preview(midi: number) {
      tone(midi, audio().context.currentTime, PREVIEW_SECONDS);
    },

    /** A frame while playing at `rate`, the audio at `time`: schedules the notes coming up. */
    frame(time: number, rate: number) {
      const { context: ctx } = audio();
      const now = ctx.currentTime;
      const expected = scheduled ? scheduled.time + (now - scheduled.at) * rate : time;
      if (scheduled && Math.abs(time - expected) > JUMP) stop();
      const notes = options.notes();
      let from: number;
      if (!scheduled) {
        // Starting (or after a jump): notes already sounding play their rest.
        for (const note of notes) {
          if (note.start >= time) break;
          if (voiced(note.type) && note.start + note.duration > time + 0.05)
            tone(note.pitch, now, (note.start + note.duration - time) / rate);
        }
        from = time;
      } else from = scheduled.until;
      const until = time + LOOKAHEAD * rate;
      for (let i = firstFrom(notes, from); i < notes.length && notes[i]!.start < until; i++) {
        const note = notes[i]!;
        if (voiced(note.type)) tone(note.pitch, now + Math.max(0, note.start - time) / rate, note.duration / rate);
      }
      scheduled = { until: Math.max(until, from), time, at: now };
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
