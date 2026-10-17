/**
 * Keeping the video with the song: the video plays at the song's time plus the video offset (`#VIDEOGAP`: a positive
 * one skips the start of the video), muted, at the song's speed. While playing, a small drift is made up by playing a
 * little faster or slower (a seek stutters, and on some videos takes longer than the drift it fixes); a big one (a
 * jump) seeks. Paused, it shows the frame at the playhead. A seek under way isn't started over. Outside the video
 * (before its start, after its end) it pauses and nothing is shown.
 */

/** The parts of a video element this needs. */
export interface VideoLike {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  playbackRate: number;
  play(): Promise<void> | void;
  pause(): void;
}

/** Further from the song than this while playing (seconds), the video seeks. */
export const JUMP = 1;
/** Closer than this, it plays at the song's speed (seconds). */
const IN_STEP = 0.04;
/** How much faster or slower it plays at most to catch up. */
const CATCH_UP = 0.1;

/** Brings `video` to the song at `time`; returns whether the video has a picture there. */
export function syncVideo(
  video: VideoLike,
  state: { time: number; playing: boolean; speed: number; offset: number },
): boolean {
  const target = state.time + state.offset;
  const end = Number.isFinite(video.duration) ? video.duration : Infinity;
  if (target < 0 || target >= end) {
    if (!video.paused) video.pause();
    return false;
  }
  const behind = target - video.currentTime;
  if (!state.playing) {
    if (!video.paused) video.pause();
    if (!video.seeking && Math.abs(behind) > 0.01) video.currentTime = target;
    return true;
  }
  if (video.seeking) return true;
  if (Math.abs(behind) > JUMP) video.currentTime = target;
  const nudge = Math.abs(behind) > IN_STEP && Math.abs(behind) <= JUMP ? Math.sign(behind) * CATCH_UP : 0;
  const rate = state.speed * (1 + nudge);
  if (video.playbackRate !== rate) video.playbackRate = rate;
  if (video.paused) void Promise.resolve(video.play()).catch(() => {});
  return true;
}
