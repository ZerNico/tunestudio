import { sql } from "drizzle-orm";
import { blob, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { Schema } from "effect";

/*
 * The tables of a `.tunestudio` file (docs/project-format.md). A change needs a migration:
 * edit this file, then run `bun run db:generate`.
 *
 * Times are seconds, absolute in the main audio. Pitches are MIDI notes (UltraStar + 60).
 * JSON columns are text, decoded with the schemas at the end.
 */

/** `key` → text: format_version, project_id, created_at, updated_at, created_with, saved_with. */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** One row: the song's details and the UltraStar headers Tune Studio doesn't model. */
export const song = sqliteTable("song", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  /** JSON list of languages (`Languages`). */
  language: text("language").notNull().default("[]"),
  year: integer("year"),
  genre: text("genre"),
  edition: text("edition"),
  creator: text("creator"),
  /** The chart's `#BPM`: one UltraStar beat is 15 / bpm seconds. */
  bpm: real("bpm").notNull(),
  gap: real("gap").notNull().default(0),
  videoGap: real("video_gap"),
  start: real("start"),
  end: real("end"),
  previewStart: real("preview_start"),
  medleyStart: real("medley_start"),
  medleyEnd: real("medley_end"),
  /** JSON list of `[name, value]` pairs in file order (`ExtraHeaders`). */
  extraHeaders: text("extra_headers").notNull().default("[]"),
  /** YouTube video ID; also supplies the audio unless a separate source is set. */
  youtubeId: text("youtube_id"),
  /** A separate YouTube audio source, or the only source for an audio-only song. */
  youtubeAudioId: text("youtube_audio_id"),
});

/** Duet voices; a solo chart has one singer. */
export const singers = sqliteTable(
  "singers",
  {
    id: integer("id").primaryKey(),
    index: integer("index").notNull(),
    name: text("name"),
  },
  (table) => [uniqueIndex("singers_index").on(table.index)],
);

export const lines = sqliteTable(
  "lines",
  {
    id: integer("id").primaryKey(),
    singerId: integer("singer_id")
      .notNull()
      .references(() => singers.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** When the next line appears; both null means automatic. */
    switchStart: real("switch_start"),
    switchEnd: real("switch_end"),
  },
  (table) => [index("lines_singer").on(table.singerId, table.position)],
);

export const NOTE_TYPES = ["normal", "golden", "freestyle", "rap", "golden-rap"] as const;

export const notes = sqliteTable(
  "notes",
  {
    id: integer("id").primaryKey(),
    lineId: integer("line_id")
      .notNull()
      .references(() => lines.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    start: real("start").notNull(),
    duration: real("duration").notNull(),
    pitch: integer("pitch").notNull(),
    /** The syllable exactly as sung, spaces kept. */
    lyric: text("lyric").notNull(),
    type: text("type", { enum: NOTE_TYPES }).notNull(),
    /** Changed by hand since it was imported or generated. */
    edited: integer("edited", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("notes_line").on(table.lineId, table.position)],
);

export const MEDIA_ROLES = ["audio", "vocals", "instrumental", "video", "cover", "background"] as const;
export const MEDIA_SOURCES = ["imported", "youtube", "generated", "chosen"] as const;

export const media = sqliteTable("media", {
  id: integer("id").primaryKey(),
  role: text("role", { enum: MEDIA_ROLES }).notNull(),
  /** The original file name, used again on export. */
  fileName: text("file_name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  duration: real("duration"),
  source: text("source", { enum: MEDIA_SOURCES }).notNull(),
  createdAt: text("created_at").notNull(),
});

/** Media bytes in 1 MiB chunks, stored exactly as imported. */
export const mediaChunks = sqliteTable(
  "media_chunks",
  {
    mediaId: integer("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.mediaId, table.index] })],
);

export const ANALYSIS_KINDS = ["pitch", "alignment", "words", "lyrics", "beats", "waveform"] as const;

/** Results of analysing media; stale once `input_sha256` no longer matches the media. */
export const analysis = sqliteTable("analysis", {
  id: integer("id").primaryKey(),
  kind: text("kind", { enum: ANALYSIS_KINDS }).notNull(),
  inputMediaId: integer("input_media_id").references(() => media.id, { onDelete: "set null" }),
  inputSha256: text("input_sha256").notNull(),
  producer: text("producer").notNull(),
  producerVersion: text("producer_version").notNull(),
  params: text("params").notNull().default("{}"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  encoding: text("encoding", { enum: ["json", "f32"] }).notNull(),
  data: blob("data", { mode: "buffer" }).notNull(),
});

export const VERSION_KINDS = ["auto", "named"] as const;

/**
 * Earlier states of the chart to go back to (`versions.ts`): taken automatically before risky edits and every while,
 * or saved and named by the user. Only the chart: media isn't kept.
 */
export const versions = sqliteTable(
  "versions",
  {
    id: integer("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    /** What it was taken before ("Before Auto pitch"), or the user's name for it. */
    label: text("label").notNull(),
    /** Automatic ones are pruned to the latest few; named ones stay until deleted. */
    kind: text("kind", { enum: VERSION_KINDS }).notNull(),
    /** How many notes and lines it has, for the list without decoding `data`. */
    notes: integer("notes").notNull(),
    lines: integer("lines").notNull(),
    /** The chart as gzipped JSON (`EditorChart`; `readVersion` reports one it can no longer decode). */
    data: blob("data", { mode: "buffer" }).notNull(),
  },
  (table) => [index("versions_kind").on(table.kind, table.createdAt)],
);

/** `key` → JSON. Unused so far: the editor keeps its view, zoom and listening settings in localStorage (`prefs.ts`). */
export const editorState = sqliteTable("editor_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** `song.language`. */
export const Languages = Schema.fromJsonString(Schema.Array(Schema.String));

/** `song.extra_headers`. */
export const ExtraHeaders = Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String])));

/** `meta.import_warnings`: what importing the song reported. */
export const ImportWarnings = Schema.fromJsonString(Schema.Array(Schema.String));
