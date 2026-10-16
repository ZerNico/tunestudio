import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import * as Errors from "../errors";
import { MODEL_FEATURES } from "../models";
import { Settings } from "../settings";
import {
  AudioFileDetails,
  ChosenImage,
  CoverCandidate,
  DownloadedDraft,
  EditorChart,
  ExportResult,
  FoundLyrics,
  HeardLyrics,
  ImportProgress,
  MadeChart,
  ModelFeatureStatus,
  ModelStatus,
  OpenedProject,
  ProjectOverview,
  RecentProjectEntry,
  RangeChart,
  SongInspection,
  SungPitch,
  ToolName,
  ToolProgress,
  ToolStatus,
  YoutubeVideo,
} from "./types";

/**
 * The calls between the renderer and Electron's main process, as an Effect RPC group (`NativeRpcs`), served over a
 * MessagePort (`electron/rpc`, `client.ts`). Inputs, outputs (`types.ts`) and errors are schemas: main decodes what
 * the renderer sends and the renderer decodes what main answers. Every call can fail with one of the user-facing
 * errors (`src/lib/errors.ts`), which arrive as those classes.
 *
 * Calls that report progress are streams: progress events, then one `Done` event with the result (`progress`). The
 * renderer's client turns them back into an iterator that yields the progress and returns the result.
 *
 * Paths the renderer sends must have come from a dialog or a drop in this session, or from the recent projects list;
 * main refuses any other path.
 */

/** Every failure a call can end with: the user-facing errors (`src/lib/errors.ts`). */
export const UserError = Schema.Union(
  Object.values(Errors).filter((value): value is (typeof Errors)[keyof typeof Errors] => Schema.isSchema(value)),
);

/** A call's progress events, then its result. */
export function progress<P extends Schema.Top, R extends Schema.Top>(event: P, result: R) {
  return Schema.Union([Schema.TaggedStruct("Progress", { progress: event }), Schema.TaggedStruct("Done", { result })]);
}

export const LogEntry = Schema.Struct({
  level: Schema.Literals(["warn", "error"]),
  message: Schema.String,
});

export const PathInput = Schema.Struct({ path: Schema.String });

/**
 * The longest video a project can be made from: songs are a few minutes, and separating the
 * voice holds the whole song in memory several times over.
 */
export const LONGEST_SONG_SECONDS = 20 * 60;

export const ProjectInput = Schema.Struct({ id: Schema.String });

export const SongInput = Schema.Struct({
  /** A song folder or its `.txt` chart. */
  path: Schema.String,
  /** A chart file name in the folder, to import another chart than the default one. */
  chart: Schema.optional(Schema.String),
});

export const ImportInput = Schema.Struct({
  path: Schema.String,
  chart: Schema.optional(Schema.String),
  includeVideo: Schema.Boolean,
  /** The `.tunestudio` file to write, from `dialogs.chooseProjectLocation`. */
  target: Schema.String,
  /** The draft `song.separate` put the vocals and music in, taken in place of the folder's. */
  draftId: Schema.optional(Schema.String),
});

export const SaveLocationInput = Schema.Struct({ name: Schema.String });

export const ExportInput = Schema.Struct({
  id: Schema.String,
  /** The folder to export into, from `dialogs.chooseExportFolder`. */
  folder: Schema.String,
  /** Replace an existing export folder (after the user confirmed it). */
  replace: Schema.Boolean,
});

export const UsdbExportInput = Schema.Struct({
  id: Schema.String,
  /** The `.txt` to write, from `dialogs.chooseUsdbFile` (replaced if it exists). */
  path: Schema.String,
});

/** The files replaced by one of the user's: the song, vocals, music and video. */
export const SongMediaRole = Schema.Literals(["audio", "vocals", "instrumental", "video"]);
export type SongMediaRole = typeof SongMediaRole.Type;

export const ReplaceMediaInput = Schema.Struct({
  id: Schema.String,
  role: SongMediaRole,
  /** The file to copy in as it is, from `dialogs.chooseMediaFile`. */
  path: Schema.String,
});

export const RecentEntryInput = Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  artist: Schema.String,
  lastOpened: Schema.String,
  cover: Schema.optional(Schema.String),
});

export const ToolsInput = Schema.Struct({
  tools: Schema.Array(ToolName),
  /** Check for newer versions even if the last check was recent. */
  force: Schema.optional(Schema.Boolean),
});

/** The project's cover: one `youtube.findCovers` found, an image file the user picked, the video's thumbnail, or none. */
export const CoverChoice = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("found"), url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("file"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("thumbnail") }),
  Schema.Struct({ kind: Schema.Literal("none") }),
]);
export type CoverChoice = typeof CoverChoice.Type;

/** A project's new cover or background: a found cover, an image file the user picked, or none. */
export const ArtworkChoice = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("found"), url: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("file"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("none") }),
]);
export type ArtworkChoice = typeof ArtworkChoice.Type;

export const ArtworkInput = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["cover", "background"]),
  choice: ArtworkChoice,
});

/** The lyrics a new project starts with: LRCLIB's as found, or text the user wrote or changed (without timing). */
export const ProjectLyrics = Schema.Struct({
  source: Schema.Literals(["lrclib", "whisper", "user"]),
  /** The LRCLIB entry they came from. */
  lrclibId: Schema.optional(Schema.Number),
  /** The language Whisper listened for (ISO 639-1); the main one when `mixed`. */
  language: Schema.optional(Schema.String),
  /** Whisper listened for several languages. */
  mixed: Schema.optional(Schema.Boolean),
  lines: Schema.Array(Schema.Struct({ start: Schema.NullOr(Schema.Number), text: Schema.String })),
});
export type ProjectLyrics = typeof ProjectLyrics.Type;

/** A YouTube video ID (checked again in main). */
export const VideoInput = Schema.Struct({ videoId: Schema.String });

export const DraftInput = Schema.Struct({ draftId: Schema.String });

export const ListenInput = Schema.Struct({
  draftId: Schema.String,
  /** ISO 639-1 code, or null for the language most of the song is in. */
  language: Schema.NullOr(Schema.String),
  /** Sung in several languages: each stretch is heard in its own. */
  mixed: Schema.Boolean,
});

export const DraftChartInput = Schema.Struct({
  draftId: Schema.String,
  /** The lyrics the chart is made from. */
  lines: ProjectLyrics.fields.lines,
  /** The language they are sung in (ISO 639-1). */
  language: Schema.String,
});

export const DraftProjectInput = Schema.Struct({
  /** The draft the song was downloaded into. */
  draftId: Schema.String,
  artist: Schema.String,
  title: Schema.String,
  year: Schema.NullOr(Schema.Number),
  genre: Schema.NullOr(Schema.String),
  cover: CoverChoice,
  lyrics: Schema.NullOr(ProjectLyrics),
  /** The language the song is sung in (ISO 639-1), or null when unknown. */
  language: Schema.NullOr(Schema.String),
  /**
   * The chart `drafts.makeChart` made (it must have been made from these lyrics and this language), or an empty one
   * to make later.
   */
  chart: Schema.Literals(["made", "empty"]),
  /** The `.tunestudio` file to write, from `dialogs.chooseProjectLocation`. */
  target: Schema.String,
});
export type DraftProjectInput = typeof DraftProjectInput.Type;

export const ToolInput = Schema.Struct({ tool: ToolName });

export const ModelFeatureInput = Schema.Struct({ feature: Schema.Literals(MODEL_FEATURES) });

/** A note's stored fields (times in seconds of the main audio, pitch as MIDI). */
export const NoteFields = Schema.Struct({
  lineId: Schema.Number,
  start: Schema.Number,
  duration: Schema.Number,
  pitch: Schema.Number,
  lyric: Schema.String,
  type: Schema.Literals(["normal", "golden", "freestyle", "rap", "golden-rap"]),
  edited: Schema.Boolean,
});
export type NoteFields = typeof NoteFields.Type;

/** A line's stored fields: its singer and when the next line appears (both null: automatically). */
export const LineFields = Schema.Struct({
  singerId: Schema.Number,
  switchStart: Schema.NullOr(Schema.Number),
  switchEnd: Schema.NullOr(Schema.Number),
});
export type LineFields = typeof LineFields.Type;

/** The song details an edit can change; a change lists only the ones it changes. */
export const SongFields = Schema.Struct({
  title: Schema.optional(Schema.String),
  artist: Schema.optional(Schema.String),
  language: Schema.optional(Schema.Array(Schema.String)),
  year: Schema.optional(Schema.NullOr(Schema.Number)),
  genre: Schema.optional(Schema.NullOr(Schema.String)),
  edition: Schema.optional(Schema.NullOr(Schema.String)),
  creator: Schema.optional(Schema.NullOr(Schema.String)),
  bpm: Schema.optional(Schema.Number),
  gap: Schema.optional(Schema.Number),
  videoGap: Schema.optional(Schema.NullOr(Schema.Number)),
  start: Schema.optional(Schema.NullOr(Schema.Number)),
  end: Schema.optional(Schema.NullOr(Schema.Number)),
  previewStart: Schema.optional(Schema.NullOr(Schema.Number)),
  medleyStart: Schema.optional(Schema.NullOr(Schema.Number)),
  medleyEnd: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Kept in the song's `#TAGS` header. */
  tags: Schema.optional(Schema.Array(Schema.String)),
  youtubeId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isPattern(/^[\w-]{11}$/)))),
  youtubeAudioId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isPattern(/^[\w-]{11}$/)))),
});
export type SongFields = typeof SongFields.Type;

/** A duet singer's name (`#P1`, `#P2`; null: none). */
export const SingerFields = Schema.Struct({ name: Schema.NullOr(Schema.String) });
export type SingerFields = typeof SingerFields.Type;

/**
 * One row of an edit, as it was and as it becomes: `before` null creates the row (with the editor's id), `after` null
 * deletes it. Main checks `before` against the file, so an editor out of step with it is noticed, not written over.
 */
export const ChartChange = Schema.Union([
  Schema.Struct({
    table: Schema.Literal("note"),
    id: Schema.Number,
    before: Schema.NullOr(NoteFields),
    after: Schema.NullOr(NoteFields),
  }),
  Schema.Struct({
    table: Schema.Literal("line"),
    id: Schema.Number,
    before: Schema.NullOr(LineFields),
    after: Schema.NullOr(LineFields),
  }),
  Schema.Struct({ table: Schema.Literal("song"), before: SongFields, after: SongFields }),
  Schema.Struct({ table: Schema.Literal("singer"), id: Schema.Number, before: SingerFields, after: SingerFields }),
]);
export type ChartChange = typeof ChartChange.Type;

export const ChartChangesInput = Schema.Struct({ id: Schema.String, changes: Schema.Array(ChartChange) });

export const AutoPitchInput = Schema.Struct({ id: Schema.String, notes: Schema.Array(Schema.Number) });

export const ChartRangeInput = Schema.Struct({
  id: Schema.String,
  singerId: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  start: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  lines: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  language: Schema.Literals(["en", "de"]),
});
export type ChartRangeInput = typeof ChartRangeInput.Type;

/** A note's new pitch (MIDI) from auto pitch. */
export const NotePitch = Schema.Struct({ id: Schema.Number, pitch: Schema.Number });

export const SongSearchInput = Schema.Struct({
  artist: Schema.String,
  title: Schema.String,
  /** The video's length in seconds, to tell versions apart. */
  duration: Schema.NullOr(Schema.Number),
});

/** A call that answers with `success`. */
const call = <const Tag extends string, P extends Schema.Top, S extends Schema.Top>(tag: Tag, payload: P, success: S) =>
  Rpc.make(tag, { payload, success, error: UserError });

/** A call that answers with nothing. */
const command = <const Tag extends string, P extends Schema.Top>(tag: Tag, payload: P) =>
  Rpc.make(tag, { payload, error: UserError });

/** A call without input. */
const query = <const Tag extends string, S extends Schema.Top>(tag: Tag, success: S) =>
  Rpc.make(tag, { success, error: UserError });

/** A call that reports progress (`P`) on the way to its result. */
const withProgress = <const Tag extends string, P extends Schema.Top, E extends Schema.Top, S extends Schema.Top>(
  tag: Tag,
  payload: P,
  event: E,
  result: S,
) => Rpc.make(tag, { payload, success: progress(event, result), error: UserError, stream: true });

const nullable = Schema.NullOr;

export class NativeRpcs extends RpcGroup.make(
  /** Forwards renderer warnings and errors to the log file. */
  command("app.log", LogEntry),

  /** Picks a song folder or chart to import. `null` when cancelled. */
  query("dialogs.chooseSong", nullable(Schema.String)),
  /** Picks a `.tunestudio` file to open. */
  query("dialogs.chooseProject", nullable(Schema.String)),
  /** Asks where to save a new project, suggesting `~/Music/Tune Studio/<name>.tunestudio`. */
  call("dialogs.chooseProjectLocation", SaveLocationInput, nullable(Schema.String)),
  /** Picks a JPEG or PNG for a cover, with a preview. `null` when cancelled. */
  query("dialogs.chooseCoverImage", nullable(ChosenImage)),
  /** Picks the folder an UltraStar export goes into. */
  query("dialogs.chooseExportFolder", nullable(Schema.String)),
  /** Picks an audio or video file, e.g. to replace the song's. `null` when cancelled. */
  call(
    "dialogs.chooseMediaFile",
    Schema.Struct({ kind: Schema.Literals(["audio", "video"]) }),
    nullable(Schema.String),
  ),
  /** Asks where to save a chart's text for USDB, suggesting `<name>.txt` in the Music folder. */
  call("dialogs.chooseUsdbFile", SaveLocationInput, nullable(Schema.String)),

  /** Reads a song folder (or chart) and reports what an import would bring in. */
  call("song.inspect", SongInput, SongInspection),
  /** Imports a song into a new project file, reporting progress, and opens it. */
  /** Separates the vocals and music from the song's audio into a new draft, reporting progress. */
  withProgress("song.separate", SongInput, ImportProgress, DraftInput),
  withProgress("song.import", ImportInput, ImportProgress, OpenedProject),

  call("project.open", PathInput, OpenedProject),
  call("project.overview", ProjectInput, ProjectOverview),
  command("project.close", ProjectInput),
  /**
   * What is sung in the project's vocals (stored, or worked out now, getting the pitch model first if needed),
   * reporting progress; null without vocals.
   */
  withProgress("project.pitch", ProjectInput, ImportProgress, nullable(SungPitch)),
  /** Writes one edit (or its undo) to the project in one transaction; fails, writing nothing, if it is out of step. */
  command("project.applyChanges", ChartChangesInput),
  /** The chart with its row ids, for the editor. */
  call("project.chart", ProjectInput, EditorChart),
  /**
   * The pitch of these notes, worked out as the chart is made but keeping their timing (the models download on first
   * use), reporting progress; notes with nothing sung to go by are left out. Nothing is written.
   */
  withProgress("project.autoPitch", AutoPitchInput, ImportProgress, Schema.Array(NotePitch)),
  /** Charts supplied lyrics inside a reviewed range, without writing the chart. */
  withProgress("project.chartRange", ChartRangeInput, ImportProgress, RangeChart),
  /** Writes the project as an UltraStar song folder. */
  call("project.exportSong", ExportInput, ExportResult),
  /** Writes the chart's text for USDB (`usdb.ts`); returns what changed on the way. */
  call("project.exportUsdb", UsdbExportInput, Schema.Struct({ warnings: Schema.Array(Schema.String) })),
  /** Replaces (or removes) the cover or background; returns the project's overview with its media as they are now. */
  call("project.setArtwork", ArtworkInput, ProjectOverview),
  /** Replaces the song, vocals, music or video with a file (checked to be one); returns the overview as it is now. */
  call("project.replaceMedia", ReplaceMediaInput, ProjectOverview),
  /** Removes the video (the song, vocals and music are only replaced); returns the overview as it is now. */
  call("project.removeVideo", ProjectInput, ProjectOverview),
  /** Separates the vocals and music from the song again, reporting progress; returns the overview as it is now. */
  withProgress("project.separate", ProjectInput, ImportProgress, ProjectOverview),

  /** The recent projects, newest first; files that no longer exist are dropped. */
  query("recents.list", Schema.Array(RecentProjectEntry)),
  command("recents.remove", PathInput),
  /** Puts a removed project back (undo). */
  command("recents.restore", RecentEntryInput),

  /** Shows a project file or an exported folder in Finder / Explorer. */
  command("files.reveal", PathInput),

  /** Reads a video's details and thumbnail with yt-dlp, installing the download tools first if needed. */
  call("youtube.inspect", VideoInput, YoutubeVideo),
  /** Album covers for the song from iTunes and MusicBrainz, best match first. */
  call("youtube.findCovers", SongSearchInput, Schema.Array(CoverCandidate)),
  /** Line-synced lyrics from LRCLIB for the version closest in length, or null. */
  call("youtube.findLyrics", SongSearchInput, nullable(FoundLyrics)),
  /** Downloads the song as the settings say into a new draft, reporting progress. */
  withProgress("youtube.download", VideoInput, ImportProgress, DownloadedDraft),

  /** Reads a picked or dropped audio file's length, tags and artwork, installing FFmpeg first if needed. */
  call("audio.inspect", PathInput, AudioFileDetails),
  /** Puts the audio file into a new draft as it is and separates the voice, reporting progress. */
  withProgress("audio.import", PathInput, ImportProgress, DownloadedDraft),

  /** What Whisper hears in the draft's vocals, reporting progress. */
  withProgress("drafts.listen", ListenInput, ImportProgress, HeardLyrics),
  /**
   * Makes the chart from the draft's vocals and these lyrics, reporting progress (the chart models download on first
   * use), and keeps it for `drafts.create`.
   */
  withProgress("drafts.makeChart", DraftChartInput, ImportProgress, MadeChart),
  /** Saves the draft as a new project with the user's choices, reporting progress, and opens it. */
  withProgress("drafts.create", DraftProjectInput, ImportProgress, OpenedProject),
  /** The project file the OS asked this window to open (`windows.ts`), once; null for none. */
  query("windows.takeOpenRequest", nullable(Schema.String)),
  /** Opens another window, on the start screen. */
  query("windows.add", Schema.Void),
  /** Throws a new project's draft away (the user cancelled). */
  command("drafts.discard", DraftInput),

  query("settings.get", Settings),
  /** Saves all settings and returns them as stored. */
  call("settings.set", Settings, Settings),

  /** What is installed of yt-dlp, QuickJS and FFmpeg. */
  query("tools.status", Schema.Array(ToolStatus)),
  /** Installs or updates the given tools as needed, reporting progress. */
  withProgress("tools.prepare", ToolsInput, ToolProgress, Schema.Array(ToolStatus)),
  /** Deletes a tool to free the space (it is installed again when needed); then what is installed. */
  call("tools.remove", ToolInput, Schema.Array(ToolStatus)),

  /** Which models are downloaded. */
  query("models.status", ModelStatus),
  /** How much of each feature's models is downloaded, for the settings screen. */
  query("models.list", Schema.Array(ModelFeatureStatus)),
  /** Downloads a feature's missing models, reporting progress; then how every feature stands. */
  withProgress("models.download", ModelFeatureInput, ImportProgress, Schema.Array(ModelFeatureStatus)),
  /** Deletes a feature's models to free the space; then how every feature stands. */
  call("models.remove", ModelFeatureInput, Schema.Array(ModelFeatureStatus)),
) {}
