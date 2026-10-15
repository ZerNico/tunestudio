import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlayback } from "./playback";

/** An audio element as far as playback uses it, with events fired by hand. */
class FakeAudio {
  static made: FakeAudio[] = [];
  currentTime = 0;
  duration = 200;
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
    const playback = createPlayback(urls, (time) => seen.push(time));
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
});
