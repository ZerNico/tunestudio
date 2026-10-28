/**
 * Failures the user can act on, shared by main (which fails with them) and the renderer (which receives them as
 * these classes over RPC). Each carries the message the renderer shows, so write it for the user: what happened and,
 * where it helps, what to do.
 */
import { Schema } from "effect";

export class NotTuneStudioFile extends Schema.TaggedError<NotTuneStudioFile>()("NotTuneStudioFile", {
  message: Schema.String,
}) {}

export class NewerProjectVersion extends Schema.TaggedError<NewerProjectVersion>()("NewerProjectVersion", {
  message: Schema.String,
}) {}

export class ProjectDamaged extends Schema.TaggedError<ProjectDamaged>()("ProjectDamaged", {
  message: Schema.String,
}) {}

export class ProjectNotOpen extends Schema.TaggedError<ProjectNotOpen>()("ProjectNotOpen", {
  message: Schema.String,
}) {}

export class FileNotFound extends Schema.TaggedError<FileNotFound>()("FileNotFound", {
  message: Schema.String,
}) {}

export class PermissionDenied extends Schema.TaggedError<PermissionDenied>()("PermissionDenied", {
  message: Schema.String,
}) {}

export class DiskFull extends Schema.TaggedError<DiskFull>()("DiskFull", { message: Schema.String }) {}

export class FileSystemFailure extends Schema.TaggedError<FileSystemFailure>()("FileSystemFailure", {
  message: Schema.String,
}) {}

export class PathNotAllowed extends Schema.TaggedError<PathNotAllowed>()("PathNotAllowed", {
  message: Schema.String,
}) {}

export class NoChartFound extends Schema.TaggedError<NoChartFound>()("NoChartFound", {
  message: Schema.String,
}) {}

export class ChartUnreadable extends Schema.TaggedError<ChartUnreadable>()("ChartUnreadable", {
  message: Schema.String,
}) {}

export class MissingMainAudio extends Schema.TaggedError<MissingMainAudio>()("MissingMainAudio", {
  message: Schema.String,
}) {}

/** A download tool (yt-dlp, QuickJS, ffmpeg) couldn't be fetched, e.g. while offline. */
export class ToolDownloadFailed extends Schema.TaggedError<ToolDownloadFailed>()("ToolDownloadFailed", {
  message: Schema.String,
}) {}

/** A downloaded tool didn't match its published checksum, so it wasn't installed. */
export class ToolChecksumMismatch extends Schema.TaggedError<ToolChecksumMismatch>()("ToolChecksumMismatch", {
  message: Schema.String,
}) {}

/** No build of a tool exists for this operating system or processor. */
export class ToolUnsupported extends Schema.TaggedError<ToolUnsupported>()("ToolUnsupported", {
  message: Schema.String,
}) {}

/** A model (voice separation, Whisper) couldn't be downloaded or didn't match its checksum. */
export class ModelDownloadFailed extends Schema.TaggedError<ModelDownloadFailed>()("ModelDownloadFailed", {
  message: Schema.String,
}) {}

/** Checking for, downloading or installing an update of Tune Studio failed. */
export class UpdateFailed extends Schema.TaggedError<UpdateFailed>()("UpdateFailed", {
  message: Schema.String,
}) {}

/** Making the chart failed: the song couldn't be read, or the lyrics couldn't be found in the vocals. */
export class ChartFailed extends Schema.TaggedError<ChartFailed>()("ChartFailed", {
  message: Schema.String,
}) {}

/** An edit expected the chart to be different from what the project holds: nothing was written. */
export class ChartOutOfStep extends Schema.TaggedError<ChartOutOfStep>()("ChartOutOfStep", {
  message: Schema.String,
}) {}

/** The chart made for a new project no longer fits its lyrics or language. */
export class ChartOutdated extends Schema.TaggedError<ChartOutdated>()("ChartOutdated", {
  message: Schema.String,
}) {}

/** Listening to the song (Whisper) failed. */
export class ListeningFailed extends Schema.TaggedError<ListeningFailed>()("ListeningFailed", {
  message: Schema.String,
}) {}

/** Tune Studio's audio engine (the native addon) couldn't be loaded. */
export class EngineUnavailable extends Schema.TaggedError<EngineUnavailable>()("EngineUnavailable", {
  message: Schema.String,
}) {}

/** Separating the voice from a song failed. */
export class SeparationFailed extends Schema.TaggedError<SeparationFailed>()("SeparationFailed", {
  message: Schema.String,
}) {}

/** YouTube won't give out the video: private, removed, age-restricted, blocked or live. */
export class VideoUnavailable extends Schema.TaggedError<VideoUnavailable>()("VideoUnavailable", {
  message: Schema.String,
}) {}

/** yt-dlp or FFmpeg failed for another reason (offline, a YouTube change, a broken file). */
export class VideoDownloadFailed extends Schema.TaggedError<VideoDownloadFailed>()("VideoDownloadFailed", {
  message: Schema.String,
}) {}

/** A picked or dropped audio or video file can't be read, has no sound (or picture), or is too long for a song. */
export class MediaUnreadable extends Schema.TaggedError<MediaUnreadable>()("MediaUnreadable", {
  message: Schema.String,
}) {}

/** A chosen file isn't an image Tune Studio can use. */
export class ImageUnreadable extends Schema.TaggedError<ImageUnreadable>()("ImageUnreadable", {
  message: Schema.String,
}) {}

/** The lyrics database couldn't be reached. */
export class LyricsUnavailable extends Schema.TaggedError<LyricsUnavailable>()("LyricsUnavailable", {
  message: Schema.String,
}) {}

/** A new project's draft was discarded (the dialog closed) or never existed. */
export class DraftGone extends Schema.TaggedError<DraftGone>()("DraftGone", {
  message: Schema.String,
}) {}

/** The game to try a song in (or any game) isn't chosen and wasn't found where it is usually installed (or is gone). */
export class GameNotFound extends Schema.TaggedError<GameNotFound>()("GameNotFound", {
  message: Schema.String,
}) {}

/** A chosen game isn't a program Tune Studio can start, or it didn't start. */
export class GameUnusable extends Schema.TaggedError<GameUnusable>()("GameUnusable", {
  message: Schema.String,
}) {}
