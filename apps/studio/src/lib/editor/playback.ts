/**
 * The editor's playback: the song, its vocals or its music (one audio element each, all on the project's media URLs),
 * one playing at a time. Switching keeps the position and whether it plays. While playing, the time is read on every
 * animation frame (an audio element's own `timeupdate` comes only about four times a second). Slower speeds keep the
 * pitch (the element's own time-stretch).
 */
import { createSignal } from "solid-js";

export const PLAYBACK_SOURCES = ["audio", "vocals", "instrumental"] as const;
export type PlaybackSource = (typeof PLAYBACK_SOURCES)[number];

export const SOURCE_LABELS: Record<PlaybackSource, string> = {
  audio: "Song",
  vocals: "Vocals",
  instrumental: "Music",
};

/** The speeds offered: normal, three quarters and half. */
export const SPEEDS = [1, 0.75, 0.5] as const;
export type Speed = (typeof SPEEDS)[number];

export interface PlaybackOptions {
  /** The time on every frame while playing (to follow the playhead, to loop). */
  onFrame?: (seconds: number) => void;
  /** Where playing starts from `seconds` (a loop starts at its range). */
  startAt?: (seconds: number) => number;
  /** Where playing goes on from once the audio ends (a loop's start), or null to stop. */
  onEnd?: () => number | null;
}

export function createPlayback(
  urls: Partial<Record<PlaybackSource, string>>,
  { onFrame = () => {}, startAt = (seconds) => seconds, onEnd = () => null }: PlaybackOptions = {},
) {
  const available = PLAYBACK_SOURCES.filter((source) => urls[source]);
  const [source, setSource] = createSignal<PlaybackSource | null>(available[0] ?? null);
  const [time, setTime] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  const [duration, setDuration] = createSignal(0);
  const [speed, setSpeed] = createSignal<Speed>(1);
  /** How loud the song plays (0-1), whichever source; the elements read it as they are made. */
  let volume = 1;
  /** The speed in effect now (the signal reads its old value just after a write). */
  let rate: Speed = 1;
  /** Made on first use, so nothing loads before the editor is shown. */
  const elements = new Map<PlaybackSource, HTMLAudioElement>();
  let frame = 0;
  /** The source playing now: signals written just now still read their old value. */
  let current = available[0] ?? null;

  const element = (which: PlaybackSource) => {
    let audio = elements.get(which);
    if (!audio) {
      audio = new Audio(urls[which]);
      audio.preload = "auto";
      audio.preservesPitch = true;
      audio.playbackRate = rate;
      audio.volume = volume;
      audio.addEventListener("loadedmetadata", () => {
        if (Number.isFinite(audio!.duration)) setDuration(Math.max(duration(), audio!.duration));
      });
      audio.addEventListener("ended", () => {
        if (which !== current) return;
        const again = onEnd();
        // Nothing to go on with before the end (a loop starting past it): stops.
        if (again === null || again >= audio!.duration) return stopTicking(audio!.duration);
        audio!.currentTime = again;
        setTime(again);
        audio!.play().catch(() => stopTicking(audio!.currentTime));
      });
      elements.set(which, audio);
    }
    return audio;
  };

  const tick = () => {
    if (current) {
      const now = element(current).currentTime;
      setTime(now);
      onFrame(now);
    }
    frame = requestAnimationFrame(tick);
  };

  function stopTicking(at: number) {
    cancelAnimationFrame(frame);
    setPlaying(false);
    setTime(at);
  }

  const play = () => {
    if (!current) return;
    const audio = element(current);
    const from = startAt(audio.currentTime);
    if (from !== audio.currentTime) {
      audio.currentTime = from;
      setTime(from);
    }
    setPlaying(true);
    audio.play().catch(() => stopTicking(audio.currentTime));
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
  };

  const pause = () => {
    if (!current) return;
    const audio = element(current);
    // While playing, the position is what is heard; pausing moves it on to the end of the audio already handed to the
    // speakers (up to a few hundred ms on Bluetooth), so resuming would skip that. Pausing keeps what was heard.
    const heard = audio.currentTime;
    audio.pause();
    audio.currentTime = heard;
    stopTicking(heard);
  };

  return {
    /** The sources this project has, in the order they are offered. */
    available,
    source,
    time,
    playing,
    /** The longest of the sources, once known (0 before). */
    duration,
    play,
    pause,
    toggle: () => (playing() ? pause() : play()),
    /** How loud the song plays (0-1), whichever source. */
    setVolume: (next: number) => {
      volume = Math.min(1, Math.max(0, next));
      for (const audio of elements.values()) audio.volume = volume;
    },
    speed,
    setSpeed: (next: Speed) => {
      rate = next;
      setSpeed(next);
      for (const audio of elements.values()) audio.playbackRate = next;
    },
    seek: (seconds: number) => {
      const at = Math.max(0, seconds);
      if (current) element(current).currentTime = at;
      setTime(at);
    },
    /** Plays another source from the same position, playing if this one was. */
    setSource: (next: PlaybackSource) => {
      if (!urls[next] || next === current) return;
      const was = current ? element(current) : null;
      const at = was?.currentTime ?? time();
      const resume = playing();
      was?.pause();
      current = next;
      setSource(next);
      element(next).currentTime = at;
      if (resume) play();
    },
    /** Loads the first source so its length is known. */
    load: () => {
      if (current) element(current);
    },
    dispose: () => {
      cancelAnimationFrame(frame);
      for (const audio of elements.values()) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      elements.clear();
    },
  };
}

export type Playback = ReturnType<typeof createPlayback>;
