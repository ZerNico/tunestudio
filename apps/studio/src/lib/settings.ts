import { Schema } from "effect";

import { GAMES } from "./games";

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

/** Remembered between new projects rather than set on the settings screen. */
export const NewProjectSettings = Schema.Struct({
  /** The language the last new project was sung in (ISO 639-1), offered first when YouTube doesn't say. */
  language: Schema.NullOr(Schema.String),
});

/**
 * The games "Try in game" opens a song in. They are main's own (`games.choose`, `games.clear`, a try): the renderer
 * can't set what is run, so `settings.set` keeps the stored ones.
 */
export const GameSettings = Schema.Struct({
  /** The game a song was last tried in, which Mod+T starts again. */
  last: Schema.NullOr(Schema.Literals(GAMES)),
  /** Each game's chosen app (a `.app` bundle on macOS, else the program); null: look for it where it is usually installed. */
  paths: Schema.Struct({
    "tune-perfect": Schema.NullOr(Schema.String),
    usdx: Schema.NullOr(Schema.String),
    vocaluxe: Schema.NullOr(Schema.String),
    performous: Schema.NullOr(Schema.String),
  }),
});

export const Settings = Schema.Struct({
  audio: AudioSettings,
  video: VideoSettings,
  newProject: NewProjectSettings,
  games: GameSettings,
});
export type Settings = typeof Settings.Type;
export type AudioFormat = Settings["audio"]["format"];
export type AudioNormalization = Settings["audio"]["normalization"];
export type VideoFormat = Settings["video"]["format"];

/** Whether downloaded audio is encoded at the bitrate set: MP3 and Ogg always, M4A and Opus only to normalize it. */
export function encodesAudio(audio: Settings["audio"]): boolean {
  return audio.format === "mp3" || audio.format === "ogg" || audio.normalization === "rewrite";
}

/** USDB Syncer's defaults. */
export const DEFAULT_SETTINGS: Settings = {
  audio: { format: "m4a", bitrate: 256, normalization: "off" },
  video: { download: true, format: "mp4", maxResolution: 1080, maxFps: 60 },
  newProject: { language: null },
  games: { last: null, paths: { "tune-perfect": null, usdx: null, vocaluxe: null, performous: null } },
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
  const storedPaths = section("games").paths;
  const gamePath = (game: (typeof GAMES)[number]): string | null => {
    const value =
      typeof storedPaths === "object" && storedPaths !== null ? (storedPaths as Record<string, unknown>)[game] : null;
    return typeof value === "string" && value !== "" ? value : null;
  };
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
    newProject: { language: pick("newProject", "language", NewProjectSettings.fields.language) },
    games: {
      last: pick("games", "last", GameSettings.fields.last),
      paths: {
        "tune-perfect": gamePath("tune-perfect"),
        usdx: gamePath("usdx"),
        vocaluxe: gamePath("vocaluxe"),
        performous: gamePath("performous"),
      },
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
