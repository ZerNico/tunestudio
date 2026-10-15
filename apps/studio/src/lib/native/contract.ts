import { eventIterator, oc, type } from "@orpc/contract";
import { Schema } from "effect";

import { MODEL_FEATURES } from "../models";
import { Settings } from "../settings";
import type {
  ExportResult,
  ImportProgress,
  OpenedProject,
  ProjectOverview,
  RecentProjectEntry,
  SongInspection,
  ToolProgress,
  ChosenImage,
  CoverCandidate,
  DownloadedDraft,
  FoundLyrics,
  HeardLyrics,
  MadeChart,
  ModelFeatureStatus,
  ModelStatus,
  ToolStatus,
  YoutubeVideo,
} from "./types";

/**
 * The contract between the renderer and Electron's main process, served over a MessagePort
 * (see `electron/rpc`). Inputs are Effect schemas, validated on the main side through Standard
 * Schema; outputs come from trusted main-process code and are typed only (`types.ts`).
 *
 * Paths the renderer sends must have come from a dialog or a drop in this session, or from the
 * recent projects list; main refuses any other path.
 */

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
});

export const SaveLocationInput = Schema.Struct({ name: Schema.String });

export const ExportInput = Schema.Struct({
  id: Schema.String,
  /** The folder to export into, from `dialogs.chooseExportFolder`. */
  folder: Schema.String,
  /** Replace an existing export folder (after the user confirmed it). */
  replace: Schema.Boolean,
});

export const RecentEntryInput = Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  artist: Schema.String,
  lastOpened: Schema.String,
  cover: Schema.optional(Schema.String),
});

export const ToolsInput = Schema.Struct({
  tools: Schema.Array(Schema.Literals(["yt-dlp", "quickjs", "ffmpeg"])),
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

export const ToolInput = Schema.Struct({ tool: Schema.Literals(["yt-dlp", "quickjs", "ffmpeg"]) });

export const ModelFeatureInput = Schema.Struct({ feature: Schema.Literals(MODEL_FEATURES) });

export const SongSearchInput = Schema.Struct({
  artist: Schema.String,
  title: Schema.String,
  /** The video's length in seconds, to tell versions apart. */
  duration: Schema.NullOr(Schema.Number),
});

export const contract = {
  app: {
    /** Forwards renderer warnings and errors to the log file. */
    log: oc.input(Schema.toStandardSchemaV1(LogEntry)),
  },
  dialogs: {
    /** Picks a song folder or chart to import. `null` when cancelled. */
    chooseSong: oc.output(type<string | null>()),
    /** Picks a `.tunestudio` file to open. */
    chooseProject: oc.output(type<string | null>()),
    /** Asks where to save a new project, suggesting `~/Music/Tune Studio/<name>.tunestudio`. */
    chooseProjectLocation: oc.input(Schema.toStandardSchemaV1(SaveLocationInput)).output(type<string | null>()),
    /** Picks a JPEG or PNG for a cover, with a preview. `null` when cancelled. */
    chooseCoverImage: oc.output(type<ChosenImage | null>()),
    /** Picks the folder an UltraStar export goes into. */
    chooseExportFolder: oc.output(type<string | null>()),
  },
  song: {
    /** Reads a song folder (or chart) and reports what an import would bring in. */
    inspect: oc.input(Schema.toStandardSchemaV1(SongInput)).output(type<SongInspection>()),
    /** Imports a song into a new project file, reporting progress, and opens it. */
    import: oc
      .input(Schema.toStandardSchemaV1(ImportInput))
      .output(eventIterator(type<ImportProgress>(), type<OpenedProject>())),
  },
  project: {
    open: oc.input(Schema.toStandardSchemaV1(PathInput)).output(type<OpenedProject>()),
    overview: oc.input(Schema.toStandardSchemaV1(ProjectInput)).output(type<ProjectOverview>()),
    close: oc.input(Schema.toStandardSchemaV1(ProjectInput)),
    /** Writes the project as an UltraStar song folder. */
    exportSong: oc.input(Schema.toStandardSchemaV1(ExportInput)).output(type<ExportResult>()),
    /**
     * Makes the chart from the project's vocals, song and lyrics, replacing its notes, reporting progress (the chart
     * models download on first use). Returns the updated overview.
     */
    makeChart: oc
      .input(Schema.toStandardSchemaV1(ProjectInput))
      .output(eventIterator(type<ImportProgress>(), type<ProjectOverview>())),
  },
  recents: {
    /** The recent projects, newest first; files that no longer exist are dropped. */
    list: oc.output(type<RecentProjectEntry[]>()),
    remove: oc.input(Schema.toStandardSchemaV1(PathInput)),
    /** Puts a removed project back (undo). */
    restore: oc.input(Schema.toStandardSchemaV1(RecentEntryInput)),
  },
  files: {
    /** Shows a project file or an exported folder in Finder / Explorer. */
    reveal: oc.input(Schema.toStandardSchemaV1(PathInput)),
  },
  youtube: {
    /** Reads a video's details and thumbnail with yt-dlp, installing the download tools first if needed. */
    inspect: oc.input(Schema.toStandardSchemaV1(VideoInput)).output(type<YoutubeVideo>()),
    /** Album covers for the song from iTunes and MusicBrainz, best match first. */
    findCovers: oc.input(Schema.toStandardSchemaV1(SongSearchInput)).output(type<CoverCandidate[]>()),
    /** Line-synced lyrics from LRCLIB for the version closest in length, or null. */
    findLyrics: oc.input(Schema.toStandardSchemaV1(SongSearchInput)).output(type<FoundLyrics | null>()),
    /** Downloads the song as the settings say into a new draft, reporting progress. */
    download: oc
      .input(Schema.toStandardSchemaV1(VideoInput))
      .output(eventIterator(type<ImportProgress>(), type<DownloadedDraft>())),
  },
  /** A new project being set up, whatever its song came from. */
  drafts: {
    /** What Whisper hears in the draft's vocals, reporting progress. */
    listen: oc
      .input(Schema.toStandardSchemaV1(ListenInput))
      .output(eventIterator(type<ImportProgress>(), type<HeardLyrics>())),
    /**
     * Makes the chart from the draft's vocals and these lyrics, reporting progress (the chart models download on first
     * use), and keeps it for `drafts.create`.
     */
    makeChart: oc
      .input(Schema.toStandardSchemaV1(DraftChartInput))
      .output(eventIterator(type<ImportProgress>(), type<MadeChart>())),
    /** Saves the draft as a new project with the user's choices, reporting progress, and opens it. */
    create: oc
      .input(Schema.toStandardSchemaV1(DraftProjectInput))
      .output(eventIterator(type<ImportProgress>(), type<OpenedProject>())),
    /** Throws a new project's draft away (the user cancelled). */
    discard: oc.input(Schema.toStandardSchemaV1(DraftInput)),
  },
  settings: {
    get: oc.output(type<Settings>()),
    /** Saves all settings and returns them as stored. */
    set: oc.input(Schema.toStandardSchemaV1(Settings)).output(type<Settings>()),
  },
  tools: {
    /** What is installed of yt-dlp, QuickJS and FFmpeg. */
    status: oc.output(type<ToolStatus[]>()),
    /** Installs or updates the given tools as needed, reporting progress. */
    prepare: oc
      .input(Schema.toStandardSchemaV1(ToolsInput))
      .output(eventIterator(type<ToolProgress>(), type<ToolStatus[]>())),
    /** Deletes a tool to free the space (it is installed again when needed); then what is installed. */
    remove: oc.input(Schema.toStandardSchemaV1(ToolInput)).output(type<ToolStatus[]>()),
  },
  models: {
    /** Which models are downloaded. */
    status: oc.output(type<ModelStatus>()),
    /** How much of each feature's models is downloaded, for the settings screen. */
    list: oc.output(type<ModelFeatureStatus[]>()),
    /** Downloads a feature's missing models, reporting progress; then how every feature stands. */
    download: oc
      .input(Schema.toStandardSchemaV1(ModelFeatureInput))
      .output(eventIterator(type<ImportProgress>(), type<ModelFeatureStatus[]>())),
    /** Deletes a feature's models to free the space; then how every feature stands. */
    remove: oc.input(Schema.toStandardSchemaV1(ModelFeatureInput)).output(type<ModelFeatureStatus[]>()),
  },
};

export type NativeContract = typeof contract;
