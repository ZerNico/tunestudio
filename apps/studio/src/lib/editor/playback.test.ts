import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlayback } from "./playback";

/** An audio element as far as playback uses it, with events fired by hand. */
class FakeAudio {
  static made: FakeAudio[] = [];
  currentTime = 0;
  duration = 200;
  playbackRate = 1;
  preservesPitch = false;
  volume = 1;
  paused = true;
  preload = "";
  listeners = new Map<string, () => void>();
  constructor(public src: string) {
    FakeAudio.made.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
  }
  removeAttribute() {}
  load() {}
  fire(name: string) {
    this.listeners.get(name)?.();
  }
}

let frames: FrameRequestCallback[] = [];
const runFrame = () => {
  const due = frames;
  frames = [];
  for (const callback of due) callback(0);
};

beforeEach(() => {
  FakeAudio.made = [];
  frames = [];
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
});
afterEach(() => vi.unstubAllGlobals());

const urls = { audio: "media://p/1", vocals: "media://p/2" };

describe("playback", () => {
  it("offers the sources the project has, the song first", () => {
    const playback = createPlayback({ vocals: "media://p/2", audio: "media://p/1" });
    expect(playback.available).toEqual(["audio", "vocals"]);
    expect(playback.source()).toBe("audio");
    expect(createPlayback({}).source()).toBeNull();
  });

  it("reads the time every frame while playing, and reports it", () => {
    const seen: number[] = [];
    const playback = createPlayback(urls, { onFrame: (time) => seen.push(time) });
    playback.play();
    const audio = FakeAudio.made[0]!;
    audio.currentTime = 1.25;
    runFrame();
    audio.currentTime = 1.27;
    runFrame();
    expect(playback.time()).toBe(1.27);
    expect(seen).toEqual([1.25, 1.27]);
    playback.pause();
    expect(playback.playing()).toBe(false);
    expect(frames).toEqual([]);
  });

  it("pauses where it was heard, not where the device buffer ended", () => {
    const playback = createPlayback(urls);
    playback.play();
    const audio = FakeAudio.made[0]!;
    audio.currentTime = 10;
    // Like Chromium: pausing moves the position on by what was already sent to the speakers.
    audio.pause = () => {
      audio.paused = true;
      audio.currentTime = 10.3;
    };
    playback.pause();
    expect(audio.currentTime).toBe(10);
    expect(playback.time()).toBe(10);
  });

  it("plays a replaced file from the same position, playing on, and leaves the others be", () => {
    const playback = createPlayback(urls);
    playback.play();
    const song = FakeAudio.made[0]!;
    song.currentTime = 42;
    playback.setUrls({ audio: "media://p/7", vocals: urls.vocals });
    const replaced = FakeAudio.made.at(-1)!;
    expect(replaced).not.toBe(song);
    expect([replaced.src, replaced.currentTime, replaced.paused, song.paused]).toEqual([
      "media://p/7",
      42,
      false,
      true,
    ]);
    expect(playback.playing()).toBe(true);
    const made = FakeAudio.made.length;
    playback.setUrls({ audio: "media://p/7", vocals: "media://p/8" });
    // The vocals weren't loaded yet: they load from the new file when played.
    expect(FakeAudio.made.length).toBe(made);
    playback.setSource("vocals");
    expect(FakeAudio.made.at(-1)!.src).toBe("media://p/8");
  });

  it("switches source at the same position, still playing", () => {
    const playback = createPlayback(urls);
    playback.play();
    FakeAudio.made[0]!.currentTime = 42;
    playback.setSource("vocals");
    const vocals = FakeAudio.made.find((audio) => audio.src === urls.vocals)!;
    expect(vocals.currentTime).toBe(42);
    expect(vocals.paused).toBe(false);
    expect(FakeAudio.made[0]!.paused).toBe(true);
    expect(playback.source()).toBe("vocals");
  });

  it("seeks, learns the length, and stops at the end", () => {
    const playback = createPlayback(urls);
    playback.load();
    const audio = FakeAudio.made[0]!;
    audio.fire("loadedmetadata");
    expect(playback.duration()).toBe(200);
    playback.seek(30);
    expect(audio.currentTime).toBe(30);
    playback.play();
    audio.fire("ended");
    expect(playback.playing()).toBe(false);
    expect(playback.time()).toBe(200);
  });

  it("plays slower with the pitch kept, on every source, and starts where it is told", () => {
    const playback = createPlayback(urls, { startAt: (time) => (time < 5 ? 5 : time) });
    playback.setSpeed(0.5);
    playback.play();
    const song = FakeAudio.made[0]!;
    expect([song.playbackRate, song.preservesPitch, song.currentTime]).toEqual([0.5, true, 5]);
    expect(playback.time()).toBe(5);
    playback.setSource("vocals");
    expect(FakeAudio.made[1]!.playbackRate).toBe(0.5);
    playback.setSpeed(1);
    expect([song.playbackRate, FakeAudio.made[1]!.playbackRate]).toEqual([1, 1]);
  });

  it("goes on from where it is told when the audio ends, else stops there", () => {
    let again: number | null = 12;
    const playback = createPlayback(urls, { onEnd: () => again });
    playback.play();
    const song = FakeAudio.made[0]!;
    song.currentTime = 200;
    song.paused = true;
    song.fire("ended");
    expect([playback.playing(), playback.time(), song.currentTime, song.paused]).toEqual([true, 12, 12, false]);
    again = null;
    song.fire("ended");
    expect([playback.playing(), playback.time()]).toEqual([false, 200]);
  });

  it("plays every source at the volume set, before or while it plays", () => {
    const playback = createPlayback(urls);
    playback.setVolume(0.4);
    playback.play();
    const song = FakeAudio.made[0]!;
    expect(song.volume).toBe(0.4);
    playback.setVolume(1.7);
    expect(song.volume).toBe(1);
    playback.setVolume(0.25);
    playback.setSource("vocals");
    expect(FakeAudio.made[1]!.volume).toBe(0.25);
  });
});
