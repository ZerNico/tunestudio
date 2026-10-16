/**
 * What the main process sends back over RPC (`rpcs.ts`), as schemas: the renderer decodes main's answers with them,
 * as main decodes what the renderer sends. Each schema has a type of the same name.
 */
import { Schema } from "effect";

import { MODEL_FEATURES } from "../models";

/** The parts of a song a project's media can play. */
export const MediaRole = Schema.Literals(["audio", "vocals", "instrumental", "video", "cover", "background"]);
export type MediaRole = typeof MediaRole.Type;

/** How a note is sung and scored. */
export const NoteType = Schema.Literals(["normal", "golden", "freestyle", "rap", "golden-rap"]);
export type NoteType = typeof NoteType.Type;

/** A note in the editor: times in seconds of the main audio, pitch as MIDI (UltraStar pitch + 60). */
export const EditorNote = Schema.Struct({
  id: Schema.Number,
  start: Schema.Number,
  duration: Schema.Number,
  pitch: Schema.Number,
  /** The syllable exactly as sung, spaces kept. */
  lyric: Schema.String,
  type: NoteType,
  /** Changed by hand since it was imported or generated. */
  edited: Schema.Boolean,
});
export type EditorNote = typeof EditorNote.Type;

/** A line of a singer's part: its notes in order, and when the next line appears (both null: automatically). */
export const EditorLine = Schema.Struct({
  id: Schema.Number,
  switchStart: Schema.NullOr(Schema.Number),
  switchEnd: Schema.NullOr(Schema.Number),
  notes: Schema.Array(EditorNote),
});
export type EditorLine = typeof EditorLine.Type;

export const EditorSinger = Schema.Struct({
  id: Schema.Number,
  /** 1 or 2 (P1, P2 in a duet). */
  index: Schema.Number,
  name: Schema.NullOr(Schema.String),
  lines: Schema.Array(EditorLine),
});
export type EditorSinger = typeof EditorSinger.Type;

/** The song's details as the editor edits them (times in seconds; null: not set). */
export const EditorSong = Schema.Struct({
  title: Schema.String,
  artist: Schema.String,
  language: Schema.Array(Schema.String),
  year: Schema.NullOr(Schema.Number),
  genre: Schema.NullOr(Schema.String),
  edition: Schema.NullOr(Schema.String),
  creator: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  /** The headers the song came with that aren't edited here (besides `#TAGS`), kept for export. */
  otherHeaders: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  videoGap: Schema.NullOr(Schema.Number),
  /** Where the game starts playing (skipping an intro). */
  start: Schema.NullOr(Schema.Number),
  /** Where it stops. */
  end: Schema.NullOr(Schema.Number),
  /** Where the song list's preview plays from. */
  previewStart: Schema.NullOr(Schema.Number),
  /** The medley excerpt: from a line's start to a line's end. */
  medleyStart: Schema.NullOr(Schema.Number),
  medleyEnd: Schema.NullOr(Schema.Number),
});
export type EditorSong = typeof EditorSong.Type;

/** The chart as the editor works on it, with the grid it is exported on (a grid step is 15 / bpm seconds from gap). */
export const EditorChart = Schema.Struct({
  bpm: Schema.Number,
  /** Seconds. */
  gap: Schema.Number,
  song: EditorSong,
  singers: Schema.Array(EditorSinger),
});
export type EditorChart = typeof EditorChart.Type;

/** What is sung in the vocals, for the editor: MIDI (fractional) every `hop` seconds, null where nothing is sung. */
export const SungPitch = Schema.Struct({
  hop: Schema.Number,
  midi: Schema.Array(Schema.NullOr(Schema.Number)),
});
export type SungPitch = typeof SungPitch.Type;

/** A project in the recent projects list. */
export const RecentProjectEntry = Schema.Struct({
  /** The `.tunestudio` file. */
  path: Schema.String,
  title: Schema.String,
  artist: Schema.String,
  /** ISO timestamp. */
  lastOpened: Schema.String,
  /** A small cover thumbnail as a data URL, cached when the project was opened. */
  cover: Schema.optional(Schema.String),
});
export type RecentProjectEntry = typeof RecentProjectEntry.Type;

/** A media file an UltraStar chart refers to, as found in its song folder. */
export const SongMediaFile = Schema.Struct({
  role: MediaRole,
  fileName: Schema.String,
  /** Bytes; absent when the file is missing. */
  size: Schema.optional(Schema.Number),
  found: Schema.Boolean,
});
export type SongMediaFile = typeof SongMediaFile.Type;

/** What importing a song folder would bring in, shown before anything is written. */
export const SongInspection = Schema.Struct({
  /** The folder the chart and its media are read from. */
  folder: Schema.String,
  /** The chart's file name in `folder`. */
  chart: Schema.String,
  /** Every chart (`.txt`) in the folder, so the user can pick another one. */
  charts: Schema.Array(Schema.String),
  title: Schema.String,
  artist: Schema.String,
  notes: Schema.Number,
  singers: Schema.Number,
  media: Schema.Array(SongMediaFile),
  /** Problems the import keeps going with: missing optional media, odd chart lines. */
  warnings: Schema.Array(Schema.String),
  /** Why the song can't be imported (its main audio is missing), or null. */
  blocker: Schema.NullOr(Schema.String),
  /** `<Artist> - <Title>`, cleaned up for use as a file name. */
  suggestedName: Schema.String,
});
export type SongInspection = typeof SongInspection.Type;

/** Progress while a project is written. */
export const ImportProgress = Schema.Struct({
  /** What is being written, for the progress label. */
  step: Schema.String,
  /** Bytes written so far and in total, or a percentage with `unit: "percent"`. */
  done: Schema.Number,
  total: Schema.Number,
  unit: Schema.optional(Schema.Literals(["bytes", "percent"])),
});
export type ImportProgress = typeof ImportProgress.Type;

/** A project open in the main process. */
export const OpenedProject = Schema.Struct({
  /** The session's ID: valid until the project is closed or the app quits. */
  id: Schema.String,
  path: Schema.String,
});
export type OpenedProject = typeof OpenedProject.Type;

export const ProjectMedia = Schema.Struct({
  id: Schema.Number,
  role: MediaRole,
  fileName: Schema.String,
  mime: Schema.String,
  size: Schema.Number,
  /** Seconds, when known. */
  duration: Schema.NullOr(Schema.Number),
  /** A `media://` URL that plays or shows the file while the project is open. */
  url: Schema.String,
});
export type ProjectMedia = typeof ProjectMedia.Type;

export const ProjectSong = Schema.Struct({
  title: Schema.String,
  artist: Schema.String,
  language: Schema.Array(Schema.String),
  year: Schema.NullOr(Schema.Number),
  genre: Schema.NullOr(Schema.String),
  edition: Schema.NullOr(Schema.String),
  creator: Schema.NullOr(Schema.String),
  bpm: Schema.Number,
  /** Seconds. */
  gap: Schema.Number,
  videoGap: Schema.NullOr(Schema.Number),
  previewStart: Schema.NullOr(Schema.Number),
  start: Schema.NullOr(Schema.Number),
  end: Schema.NullOr(Schema.Number),
  medleyStart: Schema.NullOr(Schema.Number),
  medleyEnd: Schema.NullOr(Schema.Number),
  /** UltraStar headers Tune Studio doesn't model, kept for export. */
  extraHeaders: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});
export type ProjectSong = typeof ProjectSong.Type;

export const ProjectSinger = Schema.Struct({
  index: Schema.Number,
  name: Schema.NullOr(Schema.String),
  lines: Schema.Number,
  notes: Schema.Number,
});
export type ProjectSinger = typeof ProjectSinger.Type;

/** One line of lyrics; `start` (seconds) only for synced lyrics. */
export const LyricsLine = Schema.Struct({ start: Schema.NullOr(Schema.Number), text: Schema.String });
export type LyricsLine = typeof LyricsLine.Type;

/** Everything the project screen shows. */
export const ProjectOverview = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  /** Size of the `.tunestudio` file in bytes. */
  fileSize: Schema.Number,
  createdAt: Schema.String,
  song: ProjectSong,
  singers: Schema.Array(ProjectSinger),
  lines: Schema.Number,
  notes: Schema.Number,
  goldenNotes: Schema.Number,
  /** Seconds from the first note's start to the last note's end. */
  chartStart: Schema.NullOr(Schema.Number),
  chartEnd: Schema.NullOr(Schema.Number),
  media: Schema.Array(ProjectMedia),
  /** Warnings from importing the song, kept with the project. */
  importWarnings: Schema.Array(Schema.String),
  /** Where the song was imported from, when it was. */
  importedFrom: Schema.NullOr(Schema.String),
  /** The song's lyrics and where they came from ("lrclib" or "user"), when the project has them. */
  lyrics: Schema.NullOr(
    Schema.Struct({ source: Schema.String, synced: Schema.Boolean, lines: Schema.Array(LyricsLine) }),
  ),
});
export type ProjectOverview = typeof ProjectOverview.Type;

/** The outcome of an export. */
export const ExportResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("exported"),
    folder: Schema.String,
    files: Schema.Array(Schema.String),
    warnings: Schema.Array(Schema.String),
  }),
  /** The export folder exists; ask before replacing it. */
  Schema.Struct({ status: Schema.Literal("exists"), folder: Schema.String }),
]);
export type ExportResult = typeof ExportResult.Type;

/** A download tool behind YouTube projects. */
export const ToolName = Schema.Literals(["yt-dlp", "quickjs", "ffmpeg"]);
export type ToolName = typeof ToolName.Type;

/** What is installed: the version, and when Tune Studio last checked for a newer one (ms). */
export const ToolStatus = Schema.Struct({
  tool: ToolName,
  version: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.Number),
});
export type ToolStatus = typeof ToolStatus.Type;

/** Progress while tools are checked, downloaded and installed. */
export const ToolProgress = Schema.Struct({
  tool: ToolName,
  phase: Schema.Literals(["checking", "downloading", "verifying", "installing"]),
  received: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type ToolProgress = typeof ToolProgress.Type;

/** A YouTube video, as the new-project dialog shows it. */
export const YoutubeVideo = Schema.Struct({
  videoId: Schema.String,
  url: Schema.String,
  /** The video's own title, e.g. "Artist - Song (Official Video)". */
  title: Schema.String,
  channel: Schema.String,
  /** Seconds. */
  duration: Schema.NullOr(Schema.Number),
  /** A small JPEG data URL. */
  thumbnail: Schema.NullOr(Schema.String),
  /** Suggested song details, which the user can change. */
  artist: Schema.String,
  songTitle: Schema.String,
  year: Schema.NullOr(Schema.Number),
  /** The language YouTube says it is in (ISO 639-1), or null. */
  language: Schema.NullOr(Schema.String),
});
export type YoutubeVideo = typeof YoutubeVideo.Type;

/** An album cover found for a song, with what the catalog knows about it. */
export const CoverCandidate = Schema.Struct({
  /** The full-size image (about 1200 px), downloaded when the project is created. */
  url: Schema.String,
  /** A small JPEG data URL. */
  preview: Schema.String,
  source: Schema.Literals(["itunes", "deezer", "musicbrainz"]),
  /** The song's own single or EP, or an album it is on. */
  release: Schema.Literals(["single", "album"]),
  artist: Schema.String,
  title: Schema.String,
  album: Schema.NullOr(Schema.String),
  year: Schema.NullOr(Schema.Number),
  genre: Schema.NullOr(Schema.String),
  /** Same artist and song, and about as long as the video: its year and genre can be used. */
  confident: Schema.Boolean,
});
export type CoverCandidate = typeof CoverCandidate.Type;

/** An image the user picked, with a small preview. */
export const ChosenImage = Schema.Struct({
  path: Schema.String,
  /** A small JPEG data URL. */
  preview: Schema.String,
});
export type ChosenImage = typeof ChosenImage.Type;

/** Lyrics LRCLIB has for a song, picked for the version closest to the video's length. */
export const FoundLyrics = Schema.Struct({
  source: Schema.Literal("lrclib"),
  id: Schema.Number,
  artist: Schema.String,
  title: Schema.String,
  album: Schema.NullOr(Schema.String),
  /** The length of the recording these lyrics are timed to, in seconds. */
  duration: Schema.NullOr(Schema.Number),
  /** Each line has a start time. */
  synced: Schema.Boolean,
  /** Lyrics from a different recording version, offered as a fallback. */
  versionMismatch: Schema.optional(Schema.Boolean),
  /** LRCLIB lists the song as an instrumental: there is nothing to sing. */
  instrumental: Schema.Boolean,
  lines: Schema.Array(LyricsLine),
});
export type FoundLyrics = typeof FoundLyrics.Type;

/** A new project's song, downloaded into a draft and waiting to be saved. */
export const DownloadedDraft = Schema.Struct({
  draftId: Schema.String,
  audio: Schema.Struct({ size: Schema.Number }),
  video: Schema.NullOr(Schema.Struct({ size: Schema.Number })),
  /** Why the video is missing although the settings asked for it. */
  videoProblem: Schema.NullOr(Schema.String),
});
export type DownloadedDraft = typeof DownloadedDraft.Type;

/** A feature's models, as the settings screen lists them. */
export const ModelFeatureStatus = Schema.Struct({
  feature: Schema.Literals(MODEL_FEATURES),
  /** Bytes all of its models download. */
  size: Schema.Number,
  /** Bytes of it that are downloaded: all of `size` when it is ready. */
  downloaded: Schema.Number,
  /** When the newest of its models was downloaded (ms since the epoch), or null when none is. */
  downloadedAt: Schema.NullOr(Schema.Number),
  /** Who made its models, under which license, and the version this app uses. */
  models: Schema.Array(Schema.Struct({ credit: Schema.String, license: Schema.String, version: Schema.String })),
});
export type ModelFeatureStatus = typeof ModelFeatureStatus.Type;

/** Which models are downloaded (they are fetched on first use). */
export const ModelStatus = Schema.Struct({
  separation: Schema.Boolean,
  whisper: Schema.Boolean,
  /** Every model the chart is made with. */
  chart: Schema.Boolean,
});
export type ModelStatus = typeof ModelStatus.Type;

/** A chart made for a new project, kept until the project is created. */
export const MadeChart = Schema.Struct({
  /** How many notes and lines it has. */
  notes: Schema.Number,
  lines: Schema.Number,
  /** `chartInputsKey` of what it was made from. */
  madeFrom: Schema.String,
});
export type MadeChart = typeof MadeChart.Type;

/** What Whisper heard in a song's vocals, line by line. */
export const HeardLyrics = Schema.Struct({
  /** ISO 639-1 code of the language it listened for, e.g. "de"; the main one when `mixed`. */
  language: Schema.String,
  /** Heard in several languages, each stretch in its own. */
  mixed: Schema.Boolean,
  /** Seconds from the start of the song. */
  lines: Schema.Array(Schema.Struct({ start: Schema.Number, end: Schema.Number, text: Schema.String })),
});
export type HeardLyrics = typeof HeardLyrics.Type;
