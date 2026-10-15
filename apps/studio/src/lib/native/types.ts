/**
 * What the main process sends back over the RPC contract. Plain types: the renderer trusts
 * outputs from main, so they aren't validated at runtime (inputs are, see `contract.ts`).
 */

import type { ModelFeature } from "../models";

/** The parts of a song a project's media can play. */
export type MediaRole = "audio" | "vocals" | "instrumental" | "video" | "cover" | "background";

/** How a note is sung and scored. */
export type NoteType = "normal" | "golden" | "freestyle" | "rap" | "golden-rap";

/** A note in the editor: times in seconds of the main audio, pitch as MIDI (UltraStar pitch + 60). */
export interface EditorNote {
  id: number;
  start: number;
  duration: number;
  pitch: number;
  /** The syllable exactly as sung, spaces kept. */
  lyric: string;
  type: NoteType;
  /** Changed by hand since it was imported or generated. */
  edited: boolean;
}

/** A line of a singer's part: its notes in order, and when the next line appears (both null: automatically). */
export interface EditorLine {
  id: number;
  switchStart: number | null;
  switchEnd: number | null;
  notes: EditorNote[];
}

export interface EditorSinger {
  id: number;
  /** 1 or 2 (P1, P2 in a duet). */
  index: number;
  name: string | null;
  lines: EditorLine[];
}

/** The chart as the editor works on it, with the grid it is exported on (a grid step is 15 / bpm seconds from gap). */
export interface EditorChart {
  bpm: number;
  /** Seconds. */
  gap: number;
  singers: EditorSinger[];
}

/** A project in the recent projects list. */
export interface RecentProjectEntry {
  /** The `.tunestudio` file. */
  path: string;
  title: string;
  artist: string;
  /** ISO timestamp. */
  lastOpened: string;
  /** A small cover thumbnail as a data URL, cached when the project was opened. */
  cover?: string;
}

/** A media file an UltraStar chart refers to, as found in its song folder. */
export interface SongMediaFile {
  role: MediaRole;
  fileName: string;
  /** Bytes; absent when the file is missing. */
  size?: number;
  found: boolean;
}

/** What importing a song folder would bring in, shown before anything is written. */
export interface SongInspection {
  /** The folder the chart and its media are read from. */
  folder: string;
  /** The chart's file name in `folder`. */
  chart: string;
  /** Every chart (`.txt`) in the folder, so the user can pick another one. */
  charts: string[];
  title: string;
  artist: string;
  notes: number;
  singers: number;
  media: SongMediaFile[];
  /** Problems the import keeps going with: missing optional media, odd chart lines. */
  warnings: string[];
  /** Why the song can't be imported (its main audio is missing), or null. */
  blocker: string | null;
  /** `<Artist> - <Title>`, cleaned up for use as a file name. */
  suggestedName: string;
}

/** Progress while a project is written. */
export interface ImportProgress {
  /** What is being written, for the progress label. */
  step: string;
  /** Bytes written so far and in total, or a percentage with `unit: "percent"`. */
  done: number;
  total: number;
  unit?: "bytes" | "percent";
}

/** A project open in the main process. */
export interface OpenedProject {
  /** The session's ID: valid until the project is closed or the app quits. */
  id: string;
  path: string;
}

export interface ProjectMedia {
  id: number;
  role: MediaRole;
  fileName: string;
  mime: string;
  size: number;
  /** Seconds, when known. */
  duration: number | null;
  /** A `media://` URL that plays or shows the file while the project is open. */
  url: string;
}

export interface ProjectSong {
  title: string;
  artist: string;
  language: string[];
  year: number | null;
  genre: string | null;
  edition: string | null;
  creator: string | null;
  bpm: number;
  /** Seconds. */
  gap: number;
  videoGap: number | null;
  previewStart: number | null;
  start: number | null;
  end: number | null;
  medleyStart: number | null;
  medleyEnd: number | null;
  /** UltraStar headers Tune Studio doesn't model, kept for export. */
  extraHeaders: [string, string][];
}

export interface ProjectSinger {
  index: number;
  name: string | null;
  lines: number;
  notes: number;
}

/** Everything the project screen shows. */
export interface ProjectOverview {
  id: string;
  path: string;
  /** Size of the `.tunestudio` file in bytes. */
  fileSize: number;
  createdAt: string;
  song: ProjectSong;
  singers: ProjectSinger[];
  lines: number;
  notes: number;
  goldenNotes: number;
  /** Seconds from the first note's start to the last note's end. */
  chartStart: number | null;
  chartEnd: number | null;
  media: ProjectMedia[];
  /** Warnings from importing the song, kept with the project. */
  importWarnings: string[];
  /** Where the song was imported from, when it was. */
  importedFrom: string | null;
  /** The song's lyrics and where they came from ("lrclib" or "user"), when the project has them. */
  lyrics: { source: string; synced: boolean; lines: LyricsLine[] } | null;
}

/** The outcome of an export. */
export type ExportResult =
  | { status: "exported"; folder: string; files: string[]; warnings: string[] }
  /** The export folder exists; ask before replacing it. */
  | { status: "exists"; folder: string };

/** A download tool behind YouTube projects. */
export type ToolName = "yt-dlp" | "quickjs" | "ffmpeg";

/** What is installed: the version, and when Tune Studio last checked for a newer one (ms). */
export interface ToolStatus {
  tool: ToolName;
  version: string | null;
  checkedAt: number | null;
}

/** Progress while tools are checked, downloaded and installed. */
export interface ToolProgress {
  tool: ToolName;
  phase: "checking" | "downloading" | "verifying" | "installing";
  received?: number;
  total?: number | null;
}

/** A YouTube video, as the new-project dialog shows it. */
export interface YoutubeVideo {
  videoId: string;
  url: string;
  /** The video's own title, e.g. "Artist - Song (Official Video)". */
  title: string;
  channel: string;
  /** Seconds. */
  duration: number | null;
  /** A small JPEG data URL. */
  thumbnail: string | null;
  /** Suggested song details, which the user can change. */
  artist: string;
  songTitle: string;
  year: number | null;
  /** The language YouTube says it is in (ISO 639-1), or null. */
  language: string | null;
}

/** An album cover found for a song, with what the catalog knows about it. */
export interface CoverCandidate {
  /** The full-size image (about 1200 px), downloaded when the project is created. */
  url: string;
  /** A small JPEG data URL. */
  preview: string;
  source: "itunes" | "deezer" | "musicbrainz";
  /** The song's own single or EP, or an album it is on. */
  release: "single" | "album";
  artist: string;
  title: string;
  album: string | null;
  year: number | null;
  genre: string | null;
  /** Same artist and song, and about as long as the video: its year and genre can be used. */
  confident: boolean;
}

/** An image the user picked, with a small preview. */
export interface ChosenImage {
  path: string;
  /** A small JPEG data URL. */
  preview: string;
}

/** One line of lyrics; `start` (seconds) only for synced lyrics. */
export interface LyricsLine {
  start: number | null;
  text: string;
}

/** Lyrics LRCLIB has for a song, picked for the version closest to the video's length. */
export interface FoundLyrics {
  source: "lrclib";
  id: number;
  artist: string;
  title: string;
  album: string | null;
  /** The length of the recording these lyrics are timed to, in seconds. */
  duration: number | null;
  /** Each line has a start time. */
  synced: boolean;
  /** Lyrics from a different recording version, offered as a fallback. */
  versionMismatch?: boolean;
  /** LRCLIB lists the song as an instrumental: there is nothing to sing. */
  instrumental: boolean;
  lines: LyricsLine[];
}

/** A new project's song, downloaded into a draft and waiting to be saved. */
export interface DownloadedDraft {
  draftId: string;
  audio: { size: number };
  video: { size: number } | null;
  /** Why the video is missing although the settings asked for it. */
  videoProblem: string | null;
}

/** A feature's models, as the settings screen lists them. */
export interface ModelFeatureStatus {
  feature: ModelFeature;
  /** Bytes all of its models download. */
  size: number;
  /** Bytes of it that are downloaded: all of `size` when it is ready. */
  downloaded: number;
  /** When the newest of its models was downloaded (ms since the epoch), or null when none is. */
  downloadedAt: number | null;
  /** Who made its models, under which license, and the version this app uses. */
  models: { credit: string; license: string; version: string }[];
}

/** Which models are downloaded (they are fetched on first use). */
export interface ModelStatus {
  separation: boolean;
  whisper: boolean;
  /** Every model the chart is made with. */
  chart: boolean;
}

/** A chart made for a new project, kept until the project is created. */
export interface MadeChart {
  /** How many notes and lines it has. */
  notes: number;
  lines: number;
  /** `chartInputsKey` of what it was made from. */
  madeFrom: string;
}

/** What Whisper heard in a song's vocals, line by line. */
export interface HeardLyrics {
  /** ISO 639-1 code of the language it listened for, e.g. "de"; the main one when `mixed`. */
  language: string;
  /** Heard in several languages, each stretch in its own. */
  mixed: boolean;
  /** Seconds from the start of the song. */
  lines: { start: number; end: number; text: string }[];
}
