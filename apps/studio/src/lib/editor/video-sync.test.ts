import { describe, expect, it } from "vitest";

import { JUMP, syncVideo } from "./video-sync";

function fakeVideo(duration = 100) {
  return {
    currentTime: 0,
    duration,
    paused: true,
    seeking: false,
    playbackRate: 1,
    plays: 0,
    play() {
      this.plays++;
      this.paused = false;
    },
    pause() {
      this.paused = true;
    },
  };
}

describe("the video with the song", () => {
  it("shows the frame at the playhead plus the offset while paused", () => {
    const video = fakeVideo();
    expect(syncVideo(video, { time: 10, playing: false, speed: 1, offset: 2.5 })).toBe(true);
    expect(video.currentTime).toBe(12.5);
    expect(video.paused).toBe(true);
    // Still seeking there (scrubbing): the next frame doesn't start over.
    video.seeking = true;
    syncVideo(video, { time: 11, playing: false, speed: 1, offset: 2.5 });
    expect(video.currentTime).toBe(12.5);
  });

  it("plays along at the song's speed, catching up a little drift by playing faster or slower", () => {
    const video = fakeVideo();
    video.currentTime = 10;
    syncVideo(video, { time: 10, playing: true, speed: 0.5, offset: 0 });
    expect(video).toMatchObject({ currentTime: 10, paused: false, playbackRate: 0.5, plays: 1 });
    syncVideo(video, { time: 10.3, playing: true, speed: 0.5, offset: 0 });
    expect(video.currentTime).toBe(10);
    expect(video.playbackRate).toBeCloseTo(0.55, 9);
    syncVideo(video, { time: 9.7, playing: true, speed: 0.5, offset: 0 });
    expect(video.playbackRate).toBeCloseTo(0.45, 9);
  });

  it("seeks when far off, and not again while that seek is under way", () => {
    const video = fakeVideo();
    syncVideo(video, { time: 10, playing: true, speed: 1, offset: 0 });
    expect(video.currentTime).toBe(10);
    video.seeking = true;
    syncVideo(video, { time: 10 + JUMP + 1, playing: true, speed: 1, offset: 0 });
    expect(video.currentTime).toBe(10);
  });

  it("has no picture before the video starts or after it ends", () => {
    const video = fakeVideo(20);
    video.play();
    expect(syncVideo(video, { time: 1, playing: true, speed: 1, offset: -3 })).toBe(false);
    expect(video.paused).toBe(true);
    expect(syncVideo(video, { time: 25, playing: false, speed: 1, offset: 0 })).toBe(false);
  });
});
