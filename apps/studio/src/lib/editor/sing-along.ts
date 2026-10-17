/**
 * Singing along: the microphone's pitch while the song plays, drawn over the notes (`voice`). Each pitch is folded to
 * the octave of the note it is sung on, as games count it, so it is drawn on the note. Singing a stretch again
 * replaces it; turning singing along off forgets it all.
 */
import { createSignal } from "solid-js";

import type { Platform } from "~/lib/desktop";
import type { NoteType, SungPitch } from "~/lib/native/types";

import { firstFrom, voiced } from "./chart";
import { detectPitch, foldOctave, hzToMidi } from "./voice-pitch";

/** Seconds per value of the drawn pitch. */
const HOP = 0.02;
/** How long after the song a voice reaches the microphone (real time): half the window listened to, and the input. */
const DELAY = 0.05;
/** Samples listened to at a time: long enough for a low voice's period, twice. */
const WINDOW = 2048;
/** Notes overlap at most a few deep: how far back from the time to look for the one sung on. */
const OVERLAP = 8;

/** The microphone, listened to. */
export interface Microphone {
  /** The latest `WINDOW` samples. */
  read: (into: Float32Array<ArrayBuffer>) => void;
  sampleRate: number;
  close: () => void;
}

/** Opens the microphone (the browser asks for it; echo cancellation keeps the song itself out). */
async function openMicrophone(): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  });
  const context = new AudioContext();
  await context.resume();
  const analyser = context.createAnalyser();
  analyser.fftSize = WINDOW;
  context.createMediaStreamSource(stream).connect(analyser);
  return {
    read: (into) => analyser.getFloatTimeDomainData(into),
    sampleRate: context.sampleRate,
    close: () => {
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
}

/** What to say when the microphone can't be had (`start` rejected with `error`). */
export function microphoneProblem(error: unknown, platform: Platform): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotFoundError") return "No microphone was found. Connect one and try again.";
  if (name === "NotAllowedError")
    return platform === "macos"
      ? "Allow Tune Studio in System Settings, under Privacy and Security, Microphone."
      : "Allow Tune Studio to use the microphone in your system's privacy settings.";
  return error instanceof Error ? error.message : String(error);
}

export function createSingAlong(options: {
  /** The notes sung along to, by start. */
  notes: () => readonly { start: number; duration: number; pitch: number; type: NoteType }[];
  /** The song's length (seconds). */
  length: () => number;
  /** Opens the microphone (tests pass their own). */
  open?: () => Promise<Microphone>;
}) {
  const [on, setOn] = createSignal(false);
  const [voice, setVoice] = createSignal<SungPitch | null>(null);
  let microphone: Microphone | null = null;
  let midi: (number | null)[] = [];
  /** The value the last frame wrote (a frame comes more often than a value). */
  let lastIndex = -1;
  const samples = new Float32Array(WINDOW);
  /** Ignores a start that a stop overtook. */
  let opening = 0;

  /** The voiced note sung at `time`, if any. */
  const noteAt = (time: number) => {
    const notes = options.notes();
    const from = Math.min(firstFrom(notes, time), notes.length - 1);
    for (let i = from; i >= Math.max(0, from - OVERLAP); i--) {
      const note = notes[i]!;
      if (note.start <= time && time < note.start + note.duration && voiced(note.type)) return note;
    }
    return null;
  };

  const stop = () => {
    opening++;
    microphone?.close();
    microphone = null;
    midi = [];
    lastIndex = -1;
    setVoice(null);
    setOn(false);
  };

  return {
    on,
    /** The pitch sung so far, as the roll draws a pitch. */
    voice,

    /** Starts listening; rejects when the microphone can't be had (`microphoneProblem` says why). */
    async start() {
      if (microphone) return;
      const ticket = ++opening;
      const opened = await (options.open ?? openMicrophone)();
      if (ticket !== opening) return opened.close();
      microphone = opened;
      midi = Array.from({ length: Math.ceil(Math.max(1, options.length()) / HOP) + 1 }, () => null);
      setOn(true);
    },

    stop,

    /** A playback frame with the song at `time`, playing at `speed`: what the microphone hears is put where it was sung. */
    frame(time: number, speed = 1) {
      if (!microphone) return;
      const at = time - DELAY * speed;
      const index = Math.round(at / HOP);
      if (index < 0 || index === lastIndex) return;
      lastIndex = index;
      microphone.read(samples);
      while (midi.length <= index) midi.push(null);
      const hz = detectPitch(samples, microphone.sampleRate);
      const sung = hz === null ? null : hzToMidi(hz);
      const note = sung === null ? null : noteAt(at);
      const value = sung === null ? null : note ? foldOctave(sung, note.pitch) : sung;
      if (value === midi[index]) return;
      midi[index] = value;
      // A new object, so the roll draws it again (the values are the same array).
      setVoice({ hop: HOP, midi });
    },
  };
}
