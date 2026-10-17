/**
 * A new project from an audio file the user has: what the file says about itself (FFprobe), and the song put into a
 * draft as it is, never encoded again, with its artwork and the voice separated (the first step of a new project, as
 * `youtube/youtube-draft.ts` is for a video).
 */
import { Effect, FileSystem, Path, Schema } from "effect";

import { COPYING_THE_SONG, summarizeAudioFile } from "../../src/lib/import-files";
import { LONGEST_SONG_SECONDS } from "../../src/lib/native/contract";
import type { AudioFileDetails, DownloadedDraft, ImportProgress } from "../../src/lib/native/types";
import { MediaUnreadable, mapFileError, VideoDownloadFailed } from "../errors";
import { separateStems } from "../separation/separation";
import { Desktop } from "../services/desktop";
import { Drafts } from "../services/drafts";
import { AppSettings } from "../services/settings";
import { localInput, PROBE_LOCAL_ONLY, runTool } from "../tools/ffmpeg";
import { Tools } from "../tools/tools";

/** The parts of FFprobe's JSON (`-show_format -show_streams`) used here. */
const Probe = Schema.fromJsonString(
  Schema.Struct({
    format: Schema.optional(
      Schema.Struct({
        duration: Schema.optional(Schema.String),
        tags: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
    streams: Schema.optional(
      Schema.Array(
        Schema.Struct({
          codec_type: Schema.optional(Schema.String),
          codec_name: Schema.optional(Schema.String),
          disposition: Schema.optional(Schema.Struct({ attached_pic: Schema.optional(Schema.Number) })),
        }),
      ),
    ),
  }),
);
type Probe = typeof Probe.Type;

const decodeProbe = Schema.decodeUnknownEffect(Probe);

/** Image files by the codec FFmpeg names for embedded artwork. */
const ARTWORK_EXTENSIONS: Record<string, string> = { mjpeg: ".jpg", png: ".png" };

/** What each kind of file may be, for saying so when one isn't. */
const KINDS = {
  audio: "audio. Choose an MP3, M4A, FLAC, OGG, OPUS or WAV file",
  video: "a video. Choose an MP4, WEBM, MKV, MOV or AVI file",
};

const unreadable = (name: string, kind: keyof typeof KINDS = "audio") =>
  new MediaUnreadable({ message: `Tune Studio can't read “${name}” as ${KINDS[kind]}.` });

/** FFmpeg and FFprobe, installed first if needed. */
export const ffmpegTools = Effect.gen(function* () {
  const { ffmpeg, ffprobe } = (yield* Tools.use((tools) => tools.ensure(["ffmpeg"]))).ffmpeg;
  if (!ffmpeg || !ffprobe) {
    return yield* new VideoDownloadFailed({ message: "FFmpeg couldn't be installed. Try again." });
  }
  return { ffmpeg, ffprobe };
});

/**
 * What FFprobe says about `file` (called `name`): its tags, length and streams. Fails when it has no sound, or for a
 * video no picture (artwork doesn't count).
 */
export function probe(ffprobe: string, file: string, name: string, kind: keyof typeof KINDS = "audio") {
  return Effect.gen(function* () {
    const lines: string[] = [];
    const result = yield* runTool(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...PROBE_LOCAL_ONLY, "--", file],
      (line) => Effect.sync(() => void lines.push(line)),
    ).pipe(Effect.mapError(() => unreadable(name, kind)));
    if (result.code !== 0) return yield* unreadable(name, kind);
    const info = yield* decodeProbe(lines.join("\n")).pipe(Effect.mapError(() => unreadable(name, kind)));
    const fits = (info.streams ?? []).some((stream) =>
      kind === "audio"
        ? stream.codec_type === "audio"
        : stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
    );
    if (!fits) return yield* unreadable(name, kind);
    return info;
  });
}

/** The file's length in seconds, or null when it doesn't say. */
function durationOf(info: Probe): number | null {
  const seconds = Number(info.format?.duration);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** A tag by name, whatever its case ("ARTIST" in Vorbis comments, "artist" in ID3 as FFmpeg reads it). */
function tag(info: Probe, name: string): string | null {
  const tags = info.format?.tags ?? {};
  const key = Object.keys(tags).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? "" : tags[key]!.trim();
  return value || null;
}

/** Copies the file's embedded artwork into `folder` as it is, or null when it has none. */
function extractArtwork(ffmpeg: string, file: string, info: Probe, folder: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const index = (info.streams ?? []).findIndex((stream) => stream.disposition?.attached_pic === 1);
    const extension = ARTWORK_EXTENSIONS[info.streams?.[index]?.codec_name ?? ""];
    if (index < 0 || !extension) return null;
    const artwork = path.join(folder, `artwork${extension}`);
    const result = yield* runTool(ffmpeg, [
      "-v",
      "error",
      "-y",
      ...localInput(file),
      "-map",
      `0:${index}`,
      "-c",
      "copy",
      "-frames:v",
      "1",
      "-f",
      "image2",
      artwork,
    ]);
    if (result.code !== 0 || !(yield* fs.exists(artwork))) return null;
    return artwork;
  }).pipe(Effect.orElseSucceed(() => null));
}

/** The song in an audio file, too long to be a song or not. */
export function checkLength(info: Probe, name: string) {
  const duration = durationOf(info);
  return duration !== null && duration > LONGEST_SONG_SECONDS
    ? Effect.fail(
        new MediaUnreadable({
          message: `“${name}” is longer than ${LONGEST_SONG_SECONDS / 60} minutes, too long for a song.`,
        }),
      )
    : Effect.succeed(duration);
}

/**
 * What an audio file says about itself: its length, tags and artwork (a small preview), with artist and title from
 * its tags, else from an "Artist - Title" file name.
 */
export function inspectAudioFile(file: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const name = path.basename(file);
    const size = Number((yield* fs.stat(file).pipe(mapFileError(`“${name}”`, "read"))).size);
    const { ffmpeg, ffprobe } = yield* ffmpegTools;
    const info = yield* probe(ffprobe, file, name);
    const duration = yield* checkLength(info, name);
    const fromName = summarizeAudioFile({ name, size });
    const year = Number.parseInt(tag(info, "date") ?? "", 10);

    const folder = yield* fs
      .makeTempDirectoryScoped({ prefix: "tunestudio-artwork-" })
      .pipe(mapFileError("a temporary folder", "create"));
    const artworkFile = yield* extractArtwork(ffmpeg, file, info, folder);
    const artwork = artworkFile
      ? yield* Effect.flatMap(fs.readFile(artworkFile), (bytes) =>
          Desktop.use((desktop) => desktop.thumbnail(bytes)),
        ).pipe(Effect.orElseSucceed(() => null))
      : null;

    const artist = tag(info, "artist");
    const title = tag(info, "title");
    return {
      name,
      size,
      format: fromName.format,
      duration,
      artist: artist ?? (title ? "" : fromName.artist),
      title: title ?? fromName.title,
      year: Number.isFinite(year) && year > 999 ? year : null,
      artwork,
    } satisfies AudioFileDetails;
  }).pipe(Effect.scoped);
}

/**
 * Puts an audio file into a new draft: the file as it is (never encoded again), its artwork, and the vocals and
 * instrumental separated from it, encoded as the settings say. A failed or cancelled import leaves no draft behind.
 */
export function audioFileIntoDraft(
  file: string,
  onProgress: (progress: ImportProgress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const drafts = yield* Drafts;
    const settings = yield* AppSettings.use((stored) => stored.get);
    const name = path.basename(file);
    const { ffmpeg, ffprobe } = yield* ffmpegTools;
    yield* onProgress({ step: COPYING_THE_SONG, done: 0, total: 0 });
    const info = yield* probe(ffprobe, file, name);
    yield* checkLength(info, name);

    const draft = yield* drafts.create({ kind: "file", path: file });
    return yield* Effect.gen(function* () {
      const audio = path.join(draft.folder, `audio${path.extname(file).toLowerCase()}`);
      yield* fs.copyFile(file, audio).pipe(mapFileError(`“${name}”`, "copy"));
      const cover = yield* extractArtwork(ffmpeg, file, info, draft.folder);
      const stems = yield* separateStems(
        {
          ffmpeg,
          ffprobe,
          audio,
          folder: draft.folder,
          format: settings.audio.format,
          bitrate: settings.audio.bitrate,
        },
        onProgress,
      );
      const media = { audio, video: null, videoProblem: null, cover, ...stems };
      yield* drafts.setMedia(draft.id, media);
      const size = Number((yield* fs.stat(audio).pipe(mapFileError(`“${name}”`, "copy"))).size);
      return { draftId: draft.id, audio: { size }, video: null, videoProblem: null } satisfies DownloadedDraft;
    }).pipe(Effect.onError(() => drafts.discard(draft.id)));
  });
}
