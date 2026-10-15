import { Data, Effect, FileSystem, Path, Schedule, Schema } from "effect";

import { languageCode } from "../../src/lib/languages";
import type { ImportProgress, YoutubeVideo } from "../../src/lib/native/types";
import type { Settings, VideoFormat } from "../../src/lib/settings";
import { suggestSongDetails } from "../../src/lib/youtube";
import { VideoDownloadFailed, VideoUnavailable } from "../errors";
import { AppLog } from "../services/app-log";
import { THUMBNAIL_HOSTS } from "../tools/downloads";
import { Tools } from "../tools/tools";
import { previewImage } from "./covers";
import { lastLine, rewriteLoudness, writeGainTags } from "./loudness";
import { runTool } from "./run";

/*
 * YouTube through yt-dlp, with QuickJS answering YouTube's JavaScript checks and FFmpeg
 * converting. Main only ever passes a video ID it checked, never a URL or text from the
 * renderer, so nothing the user types can turn into a yt-dlp option.
 */

const VIDEO_ID = /^[\w-]{11}$/;

/** The canonical link for a video. */
export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** The parts of yt-dlp's `--dump-single-json` output Tune Studio uses. */
const VideoJson = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  channel: Schema.optional(Schema.NullOr(Schema.String)),
  uploader: Schema.optional(Schema.NullOr(Schema.String)),
  duration: Schema.optional(Schema.NullOr(Schema.Number)),
  artist: Schema.optional(Schema.NullOr(Schema.String)),
  track: Schema.optional(Schema.NullOr(Schema.String)),
  release_year: Schema.optional(Schema.NullOr(Schema.Number)),
  live_status: Schema.optional(Schema.NullOr(Schema.String)),
  /** The language the uploader set, e.g. "en" or "en-US". */
  language: Schema.optional(Schema.NullOr(Schema.String)),
  /** YouTube's automatic captions by language; "de-orig" is the one heard in the video itself. */
  automatic_captions: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  thumbnails: Schema.optional(
    Schema.Array(
      Schema.Struct({
        url: Schema.String,
        width: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});
type VideoJson = typeof VideoJson.Type;

const decodeVideoJson = Schema.decodeUnknownEffect(Schema.fromJsonString(VideoJson));

/** The executables a YouTube download runs. */
export interface YoutubeTools {
  readonly ytDlp: string;
  readonly qjs: string;
  readonly ffmpeg: string;
  /** yt-dlp's cache (YouTube's player code, so its checks are answered faster next time). */
  readonly cacheDir: string;
}

/**
 * The language a video is in, as far as YouTube knows: the one its uploader set, else the one its automatic captions
 * were heard in (the "-orig" ones; the others are translations). Null when neither says.
 */
export function videoLanguage(info: Pick<VideoJson, "language" | "automatic_captions">): string | null {
  const set = languageCode(info.language);
  if (set) return set;
  const heard = Object.keys(info.automatic_captions ?? {}).filter((key) => key.endsWith("-orig"));
  return heard.length === 1 ? languageCode(heard[0]) : null;
}

/** yt-dlp's options shared by every run. */
function baseArgs(tools: YoutubeTools, path: Path.Path): string[] {
  return [
    "--ignore-config",
    "--no-playlist",
    "--color",
    "never",
    // Only the bundled QuickJS, never a JavaScript runtime that happens to be installed.
    "--no-js-runtimes",
    "--js-runtimes",
    `quickjs:${tools.qjs}`,
    "--ffmpeg-location",
    path.dirname(tools.ffmpeg),
    "--cache-dir",
    tools.cacheDir,
  ];
}

const unavailable = (message: string) => new VideoUnavailable({ message });

/** Turns yt-dlp's error output into something to tell the user. */
export function youtubeError(stderr: string): VideoUnavailable | VideoDownloadFailed {
  const error =
    stderr
      .split(/\r?\n/)
      .findLast((line) => line.startsWith("ERROR:"))
      ?.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]{11}:\s*)?/, "") ?? lastLine(stderr);
  if (/private video/i.test(error)) return unavailable("This video is private, so it can't be downloaded.");
  if (/confirm your age|age.restricted|inappropriate for some users/i.test(error)) {
    return unavailable("YouTube only shows this video to signed-in adults, so it can't be downloaded.");
  }
  if (/members.only|join this channel/i.test(error)) {
    return unavailable("This video is only for channel members, so it can't be downloaded.");
  }
  if (/not available in your country|geo.?restrict/i.test(error)) {
    return unavailable("This video isn't available in your country.");
  }
  if (/live event|is live|premieres in/i.test(error)) {
    return unavailable("This video is live or hasn't premiered yet. Try again once it can be watched in full.");
  }
  if (/video unavailable|has been removed|no longer available|does not exist|account .* terminated/i.test(error)) {
    return unavailable("This video isn't available on YouTube anymore.");
  }
  if (
    /getaddrinfo|name resolution|resolve host|network is unreachable|timed out|connection (refused|reset)/i.test(error)
  ) {
    return new VideoDownloadFailed({
      message: "Couldn't reach YouTube. Check your internet connection and try again.",
    });
  }
  if (/not a bot|sign in to confirm/i.test(error)) {
    return new VideoDownloadFailed({
      message: "YouTube asked to confirm this isn't a bot. Wait a while, then try again.",
    });
  }
  return new VideoDownloadFailed({ message: `Couldn't get the video from YouTube: ${error}` });
}

/** The tools for a YouTube download, installing or updating them first if needed. */
function youtubeTools(force = false) {
  return Effect.gen(function* () {
    const tools = yield* Tools;
    const path = yield* Path.Path;
    const installed = yield* tools.ensure(["yt-dlp", "quickjs", "ffmpeg"], { force });
    const ytDlp = installed["yt-dlp"]["yt-dlp"];
    const qjs = installed.quickjs.qjs;
    const ffmpeg = installed.ffmpeg.ffmpeg;
    if (!ytDlp || !qjs || !ffmpeg) {
      return yield* new VideoDownloadFailed({ message: "The download tools are incomplete. Try again." });
    }
    const cacheDir = path.join(tools.folder, "yt-dlp-cache");
    return { ytDlp, qjs, ffmpeg, cacheDir } satisfies YoutubeTools;
  });
}

/**
 * Runs yt-dlp. YouTube changes often and an older yt-dlp then fails, so a failure that isn't
 * about the video itself checks for a newer yt-dlp right away and, if there is one, runs again.
 */
function withYtDlp<A, R>(run: (tools: YoutubeTools) => Effect.Effect<A, VideoUnavailable | VideoDownloadFailed, R>) {
  return Effect.gen(function* () {
    const tools = yield* youtubeTools();
    const first = yield* Effect.result(run(tools));
    if (first._tag === "Success") return first.success;
    if (first.failure._tag === "VideoUnavailable" || /internet connection/.test(first.failure.message)) {
      return yield* first.failure;
    }
    const updated = yield* youtubeTools(true).pipe(Effect.orElseSucceed(() => tools));
    if (updated.ytDlp === tools.ytDlp) return yield* first.failure;
    yield* AppLog.use((log) => log.write("INFO", "youtube", "Retrying with the updated yt-dlp"));
    return yield* run(updated);
  });
}

/** The thumbnail to preview: the largest JPEG up to 1280 pixels wide (WebP may not decode). */
function previewThumbnail(info: VideoJson): string | undefined {
  const jpegs = (info.thumbnails ?? []).filter((thumbnail) => new URL(thumbnail.url).pathname.endsWith(".jpg"));
  return jpegs
    .filter((thumbnail) => (thumbnail.width ?? 0) <= 1280)
    .toSorted((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;
}

/** Reads a video's details and a small thumbnail for the dialog. Nothing is downloaded but those. */
export function inspectVideo(videoId: string) {
  return Effect.gen(function* () {
    if (!VIDEO_ID.test(videoId)) {
      return yield* new VideoUnavailable({ message: "That doesn't look like a YouTube video link." });
    }
    const info = yield* withYtDlp((tools) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        let json = "";
        const result = yield* runTool(
          tools.ytDlp,
          [...baseArgs(tools, path), "--skip-download", "--dump-single-json", "--", watchUrl(videoId)],
          (line) => Effect.sync(() => void (json += line)),
        ).pipe(Effect.mapError((message) => new VideoDownloadFailed({ message: `Couldn't start yt-dlp: ${message}` })));
        if (result.code !== 0) {
          yield* AppLog.use((log) => log.write("WARN", "youtube", lastLine(result.stderr)));
          return yield* youtubeError(result.stderr);
        }
        return yield* decodeVideoJson(json).pipe(
          Effect.mapError(() => new VideoDownloadFailed({ message: "yt-dlp's answer couldn't be read. Try again." })),
        );
      }),
    );
    if (info.live_status === "is_live" || info.live_status === "is_upcoming") {
      return yield* new VideoUnavailable({
        message: "This video is live or hasn't premiered yet. Try again once it can be watched in full.",
      });
    }

    const thumbnailUrl = previewThumbnail(info);
    const thumbnail = thumbnailUrl ? yield* previewImage(thumbnailUrl, THUMBNAIL_HOSTS) : null;
    const channel = info.channel ?? info.uploader ?? "";
    const suggested = suggestSongDetails({ title: info.title, channel, artist: info.artist, track: info.track });
    return {
      videoId,
      url: watchUrl(videoId),
      title: info.title,
      channel,
      duration: info.duration ?? null,
      thumbnail,
      artist: suggested.artist,
      songTitle: suggested.title,
      year: info.release_year ?? null,
      language: videoLanguage(info),
    } satisfies YoutubeVideo;
  });
}

/** The largest width yt-dlp may pick for each maximum height. */
const WIDTHS: Record<number, number> = { 2160: 3840, 1440: 2560, 1080: 1920, 720: 1280, 480: 854, 360: 640 };

/** yt-dlp's format choice for the video, as USDB Syncer builds it: the wished-for codec first, then fallbacks. */
export function videoFormat(video: Settings["video"]): string {
  const containers: Record<VideoFormat, string | null> = {
    best: null,
    mp4: "mp4",
    "mp4-av1": "mp4",
    "mp4-avc": "mp4",
    "mp4-vp9": "mp4",
    webm: "webm",
  };
  const codecs: Partial<Record<VideoFormat, string>> = {
    "mp4-av1": "av01",
    "mp4-avc": "^(avc|h264)",
    "mp4-vp9": "^vp0?9",
  };
  const container = containers[video.format] ? `[ext=${containers[video.format]}]` : "";
  const codec = codecs[video.format] ? `[vcodec~='${codecs[video.format]}']` : "";
  const choices = ["bestvideo*"];
  if (container) choices.unshift(`bestvideo*${container}`);
  if (codec) choices.unshift(`bestvideo*${container}${codec}`);
  // `<=?` also lets through formats without size or frame rate information. Every choice keeps
  // the limits; only when nothing fits them does the best of the rest come down.
  const limits = `[width<=?${WIDTHS[video.maxResolution]}][height<=?${video.maxResolution}][fps<=?${video.maxFps}]`;
  return [...choices.map((choice) => `${choice}${limits}`), ...choices].join("/");
}

/** yt-dlp's format choice for the audio: the wished-for format if YouTube has it as is. */
export function audioFormat(audio: Settings["audio"]): string {
  const native = audio.format === "m4a" ? "[ext=m4a]" : audio.format === "opus" ? "[acodec=opus]" : "";
  return native ? `bestaudio${native}/bestaudio/bestaudio*` : "bestaudio/bestaudio*";
}

/** yt-dlp's names for the audio formats. */
const AUDIO_CODECS: Record<Settings["audio"]["format"], string> = {
  m4a: "m4a",
  mp3: "mp3",
  ogg: "vorbis",
  opus: "opus",
};

/** The media a download produced, in its work folder. */
export interface DownloadedMedia {
  readonly audio: string;
  readonly video: string | null;
  /** Why the video is missing although it was wanted. */
  readonly videoProblem: string | null;
  /** The thumbnail cropped to a square, for `#COVER`. */
  readonly cover: string | null;
  /** The vocals separated from the audio, encoded like it (`#VOCALS`). */
  readonly vocals: string | null;
  /** The audio without the vocals, encoded like it (`#INSTRUMENTAL`). */
  readonly instrumental: string | null;
}

/** Lines yt-dlp prints for Tune Studio (see `--progress-template` and `--print`). */
const PROGRESS = /^@progress (\d+) (\S+) (\S+)$/;
const FILE = /^@file (.+)$/;

/**
 * Downloads one stream with yt-dlp into `folder` as `<name>.<ext>`, reporting the bytes as
 * `step`, and returns where the file ended up.
 */
function fetchStream(
  tools: YoutubeTools,
  videoId: string,
  options: { name: string; format: string; extra: string[]; step: string; folder: string },
  onProgress: (progress: ImportProgress) => Effect.Effect<void>,
) {
  const attempt = Effect.gen(function* () {
    const path = yield* Path.Path;
    let file: string | null = null;
    const result = yield* runTool(
      tools.ytDlp,
      [
        ...baseArgs(tools, path),
        "--newline",
        "--quiet",
        "--progress",
        "--progress-template",
        "download:@progress %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
        "--print",
        "after_move:@file %(filepath)s",
        "--no-part",
        "-f",
        options.format,
        ...options.extra,
        "-o",
        path.join(options.folder, `${options.name}.%(ext)s`),
        "--",
        watchUrl(videoId),
      ],
      (line) => {
        const progress = PROGRESS.exec(line);
        if (progress) {
          const done = Number(progress[1]);
          const total = Number(progress[2]) || Number(progress[3]) || 0;
          return onProgress({ step: options.step, done, total: Math.max(total, done) });
        }
        const printed = FILE.exec(line);
        if (printed) file = printed[1]!.trim();
        return Effect.void;
      },
    ).pipe(Effect.mapError((message) => new VideoDownloadFailed({ message: `Couldn't start yt-dlp: ${message}` })));
    if (result.code !== 0) {
      yield* AppLog.use((log) => log.write("WARN", "youtube", lastLine(result.stderr)));
      return yield* FORBIDDEN.test(result.stderr) ? new Forbidden() : youtubeError(result.stderr);
    }
    if (!file) return yield* new VideoDownloadFailed({ message: "yt-dlp didn't say where it saved the file." });
    return file as string;
  });
  // YouTube now and then refuses a download link it just handed out. yt-dlp's own retries reuse
  // that link, so the whole run starts over with a fresh one.
  return attempt.pipe(
    Effect.retry({ times: 2, while: (error) => error._tag === "Forbidden", schedule: Schedule.spaced("2 seconds") }),
    Effect.catchTag("Forbidden", () =>
      Effect.fail(
        new VideoDownloadFailed({
          message: "YouTube refused the download a few times in a row. Wait a moment, then try again.",
        }),
      ),
    ),
  );
}

const FORBIDDEN = /HTTP Error 403/;

/** YouTube refused the download link (HTTP 403); a fresh run usually gets one that works. */
class Forbidden extends Data.TaggedError("Forbidden") {}

/**
 * Downloads a video's audio, and its video if the settings ask for it, into `folder`: the
 * audio in the chosen format (converted, normalized or tagged as set), the video without sound
 * (UltraStar plays the audio file), and the thumbnail as a square cover.
 */
export function downloadVideo(
  videoId: string,
  settings: Settings,
  folder: string,
  onProgress: (progress: ImportProgress) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    if (!VIDEO_ID.test(videoId)) {
      return yield* new VideoUnavailable({ message: "That doesn't look like a YouTube video link." });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { audio, video: videoSettings } = settings;
    const rewrite = audio.normalization === "rewrite";

    const downloaded = yield* withYtDlp((tools) =>
      Effect.gen(function* () {
        yield* onProgress({ step: "Downloading the audio", done: 0, total: 0 });
        const audioFile = yield* fetchStream(
          tools,
          videoId,
          {
            name: rewrite ? "source" : "audio",
            format: audioFormat(audio),
            // Normalizing encodes anyway, so the conversion happens there in one go.
            extra: [
              ...(rewrite
                ? []
                : ["-x", "--audio-format", AUDIO_CODECS[audio.format], "--audio-quality", `${audio.bitrate}K`]),
              "--write-thumbnail",
              "--convert-thumbnails",
              "jpg",
              "-o",
              `thumbnail:${path.join(folder, "thumbnail.%(ext)s")}`,
            ],
            step: "Downloading the audio",
            folder,
          },
          onProgress,
        );

        return { tools, audioFile };
      }),
    );

    // The video in a run of its own, so a yt-dlp that can't get it is updated and tried again
    // like for the audio; a video that still can't be had leaves an audio-only project.
    let video: string | null = null;
    let videoProblem: string | null = null;
    if (videoSettings.download) {
      yield* onProgress({ step: "Downloading the video", done: 0, total: 0 });
      const result = yield* Effect.result(
        withYtDlp((tools) =>
          fetchStream(
            tools,
            videoId,
            { name: "video", format: videoFormat(videoSettings), extra: [], step: "Downloading the video", folder },
            onProgress,
          ),
        ),
      );
      if (result._tag === "Success") video = result.success;
      else videoProblem = result.failure.message;
    }

    const { tools } = downloaded;
    let audioFile = downloaded.audioFile;
    if (audio.normalization !== "off") {
      yield* onProgress({ step: "Adjusting the volume", done: 0, total: 0 });
      if (rewrite) {
        const normalized = path.join(folder, `audio.${audio.format}`);
        yield* rewriteLoudness(tools.ffmpeg, audioFile, normalized, { format: audio.format, bitrate: audio.bitrate });
        audioFile = normalized;
      } else {
        yield* writeGainTags(tools.ffmpeg, audioFile, audio.format);
      }
    }

    const cover = yield* squareCover(tools.ffmpeg, path.join(folder, "thumbnail.jpg"), path.join(folder, "cover.jpg"));
    if (cover === null) yield* fs.remove(path.join(folder, "thumbnail.jpg")).pipe(Effect.ignore);
    return {
      audio: audioFile,
      video,
      videoProblem,
      cover,
      vocals: null,
      instrumental: null,
    } satisfies DownloadedMedia;
  });
}

/** Crops the thumbnail's middle to a square (YouTube's are 16:9), or null without one. */
function squareCover(ffmpeg: string, thumbnail: string, cover: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(thumbnail).pipe(Effect.orElseSucceed(() => false)))) return null;
    const result = yield* runTool(ffmpeg, [
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      thumbnail,
      "-vf",
      "crop='min(iw,ih)':'min(iw,ih)'",
      "-frames:v",
      "1",
      "-q:v",
      "2",
      cover,
    ]).pipe(Effect.orElseSucceed(() => ({ code: 1, stderr: "" })));
    return result.code === 0 ? cover : null;
  });
}
