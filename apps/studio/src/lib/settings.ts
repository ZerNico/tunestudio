import { Schema } from "effect";

/**
 * App settings, shared by the renderer (the settings screen) and main (which stores them and
 * uses them for downloads). The download options follow USDB Syncer's, so charts from Tune
 * Studio come with the media people are used to. They only shape media downloaded from now on:
 * audio and video already in a project are never converted.
 */

/**
 * YouTube serves M4A (AAC) and Opus, which are saved as they come; MP3 and OGG are converted
 * from them. No lossless choice: YouTube's audio is lossy, so FLAC would only be bigger.
 */
export const AUDIO_FORMATS = ["m4a", "mp3", "ogg", "opus"] as const;
export const AUDIO_BITRATES = [128, 160, 192, 256, 320] as const;
export const AUDIO_NORMALIZATIONS = ["off", "replaygain", "rewrite"] as const;
export const VIDEO_FORMATS = ["best", "mp4", "mp4-av1", "mp4-avc", "mp4-vp9", "webm"] as const;
export const VIDEO_RESOLUTIONS = [2160, 1440, 1080, 720, 480, 360] as const;
export const VIDEO_FPS = [60, 30] as const;

export const AudioSettings = Schema.Struct({
  format: Schema.Literals(AUDIO_FORMATS),
  /** For audio that is converted or normalized; other M4A and Opus downloads keep YouTube's bitrate. */
  bitrate: Schema.Literals(AUDIO_BITRATES),
  normalization: Schema.Literals(AUDIO_NORMALIZATIONS),
});

export const VideoSettings = Schema.Struct({
  /** Whether YouTube projects get the video too, or only the audio. */
  download: Schema.Boolean,
  format: Schema.Literals(VIDEO_FORMATS),
  /** The largest height to download, in pixels. */
  maxResolution: Schema.Literals(VIDEO_RESOLUTIONS),
  maxFps: Schema.Literals(VIDEO_FPS),
});

export const Settings = Schema.Struct({ audio: AudioSettings, video: VideoSettings });
export type Settings = typeof Settings.Type;
export type AudioFormat = Settings["audio"]["format"];
export type AudioNormalization = Settings["audio"]["normalization"];
export type VideoFormat = Settings["video"]["format"];

/** USDB Syncer's defaults. */
export const DEFAULT_SETTINGS: Settings = {
  audio: { format: "m4a", bitrate: 256, normalization: "off" },
  video: { download: true, format: "mp4", maxResolution: 1080, maxFps: 60 },
};

/**
 * Settings from whatever was stored: each value that is missing or no longer valid (an older or
 * newer app version, a hand-edited file) falls back to its default, and the rest are kept.
 */
export function settingsFrom(stored: unknown): Settings {
  const section = (key: keyof Settings): Record<string, unknown> => {
    const value = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>)[key] : undefined;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  };
  const pick = <K extends keyof Settings, F extends keyof Settings[K]>(
    key: K,
    field: F,
    schema: Schema.Top,
  ): Settings[K][F] => {
    const value = section(key)[field as string];
    return Schema.is(schema)(value) ? (value as Settings[K][F]) : DEFAULT_SETTINGS[key][field];
  };
  const audio = AudioSettings.fields;
  const video = VideoSettings.fields;
  return {
    audio: {
      format: pick("audio", "format", audio.format),
      bitrate: pick("audio", "bitrate", audio.bitrate),
      normalization: pick("audio", "normalization", audio.normalization),
    },
    video: {
      download: pick("video", "download", video.download),
      format: pick("video", "format", video.format),
      maxResolution: pick("video", "maxResolution", video.maxResolution),
      maxFps: pick("video", "maxFps", video.maxFps),
    },
  };
}

/** How the options read in the settings screen. */
export const AUDIO_FORMAT_LABELS: Record<AudioFormat, string> = {
  m4a: "M4A (AAC)",
  mp3: "MP3",
  ogg: "OGG (Vorbis)",
  opus: "Opus",
};

export const AUDIO_NORMALIZATION_LABELS: Record<AudioNormalization, string> = {
  off: "Off",
  replaygain: "ReplayGain tags",
  rewrite: "Normalize the audio",
};

export const VIDEO_FORMAT_LABELS: Record<VideoFormat, string> = {
  best: "Best available",
  mp4: "MP4 (best codec)",
  "mp4-avc": "MP4 (H.264)",
  "mp4-av1": "MP4 (AV1)",
  "mp4-vp9": "MP4 (VP9)",
  webm: "WebM (VP9)",
};
