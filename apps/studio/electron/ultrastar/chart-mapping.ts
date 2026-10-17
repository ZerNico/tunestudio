import {
  type ChartDocument,
  type ChartLineBreak,
  type ChartNote,
  type ChartGrid,
  defaultBreakTick,
  gridFromMetadata,
  type NoteType,
  parseDecimal,
  secondsToTicks,
  ticksToSeconds,
} from "@tunestudio/ultrastar";

import { formatMetaTags, parseMetaTags, sourceMetaTags } from "./meta-tags";

/*
 * Between an UltraStar chart (the parser's `ChartDocument`) and a project's rows. Headers the
 * project models become song columns, media headers become media rows (handled by the import),
 * and every other header is kept in `extraHeaders`, in file order, so an export writes it back.
 */

/** The song row, without its ID. Times are seconds. */
export interface SongDetails {
  title: string;
  artist: string;
  language: string[];
  year: number | null;
  genre: string | null;
  edition: string | null;
  creator: string | null;
  bpm: number;
  gap: number;
  videoGap: number | null;
  start: number | null;
  end: number | null;
  previewStart: number | null;
  medleyStart: number | null;
  medleyEnd: number | null;
  extraHeaders: [string, string][];
  /** The song's YouTube video id (usdb_syncer's `#VIDEO:v=…`), or null. */
  youtubeId: string | null;
  /** A separate audio upload (`a=…`), or null to use the video's audio. */
  youtubeAudioId: string | null;
}

export interface ChartNoteRow {
  start: number;
  duration: number;
  pitch: number;
  lyric: string;
  type: NoteType;
}

export interface ChartLineRow {
  switchStart: number | null;
  switchEnd: number | null;
  notes: ChartNoteRow[];
}

export interface ChartSingerRow {
  /** 1 or 2: `P1` / `P2`. */
  index: number;
  name: string | null;
  lines: ChartLineRow[];
}

export interface ProjectChart {
  song: SongDetails;
  singers: ChartSingerRow[];
}

/** The headers naming media files; the import reads them, the export writes them. */
export const MEDIA_HEADERS = ["AUDIO", "MP3", "VOCALS", "INSTRUMENTAL", "VIDEO", "COVER", "BACKGROUND"] as const;

/**
 * Not kept: rewritten on export (the file is UTF-8, version 1.2.0, absolute timing), meaningless once P3's notes are
 * copied into P1 and P2, or deprecated 0.x headers that mean nothing for singing. USDX 1.0 and later ignores
 * `#NOTESGAP`, which only ever moved the beat click and grid lines, never notes; `#RESOLUTION` was an editor setting.
 */
const DROPPED_HEADERS = new Set(["ENCODING", "VERSION", "RELATIVE", "P3", "DUETSINGERP3", "NOTESGAP", "RESOLUTION"]);

const SINGER_HEADERS: Record<string, number> = { P1: 1, P2: 2, DUETSINGERP1: 1, DUETSINGERP2: 2 };

const TEXT_HEADERS = { GENRE: "genre", EDITION: "edition", CREATOR: "creator" } as const;

type TimeField = "videoGap" | "start" | "end" | "previewStart" | "medleyStart" | "medleyEnd";

/** Headers holding times, and how their values convert to seconds. */
const TIME_HEADERS: Record<string, { field: TimeField; unit: "seconds" | "milliseconds" | "beats" }> = {
  VIDEOGAP: { field: "videoGap", unit: "seconds" },
  START: { field: "start", unit: "seconds" },
  END: { field: "end", unit: "milliseconds" },
  PREVIEWSTART: { field: "previewStart", unit: "seconds" },
  MEDLEYSTARTBEAT: { field: "medleyStart", unit: "beats" },
  MEDLEYENDBEAT: { field: "medleyEnd", unit: "beats" },
  MEDLEYSTART: { field: "medleyStart", unit: "milliseconds" },
  MEDLEYEND: { field: "medleyEnd", unit: "milliseconds" },
};

/** A decimal header value (decimal comma allowed), or undefined when it isn't one. */
function decimal(value: string): number | undefined {
  try {
    return parseDecimal(value);
  } catch {
    return undefined;
  }
}

/**
 * Splits a parsed chart into the project's song details and singers, lines and notes.
 * `warnings` collects header values that couldn't be read (they are kept as extra headers).
 */
export function chartToProject(document: ChartDocument): { chart: ProjectChart; warnings: string[] } {
  const warnings: string[] = [];
  const grid = gridFromMetadata(document.metadata);
  const song: SongDetails = {
    title: "",
    artist: "",
    language: [],
    year: null,
    genre: null,
    edition: null,
    creator: null,
    bpm: grid.bpm,
    gap: grid.gap / 1000,
    videoGap: null,
    start: null,
    end: null,
    previewStart: null,
    medleyStart: null,
    medleyEnd: null,
    extraHeaders: [],
    youtubeId: null,
    youtubeAudioId: null,
  };
  const singerNames = new Map<number, string>();
  const keep = (key: string, value: string) => song.extraHeaders.push([key, value]);

  for (const [key, value] of Object.entries(document.metadata)) {
    const trimmed = value.trim();
    // An empty value is no header in the v1 format.
    if (!trimmed) continue;
    if (key === "TITLE") song.title = trimmed;
    else if (key === "ARTIST") song.artist = trimmed;
    else if (key === "BPM" || key === "GAP" || DROPPED_HEADERS.has(key)) continue;
    else if ((MEDIA_HEADERS as readonly string[]).includes(key)) continue;
    else if (key === "LANGUAGE") {
      song.language = trimmed
        .split(/[,;]/)
        .map((language) => language.trim())
        .filter(Boolean);
    } else if (key === "YEAR") {
      if (/^\d{1,4}$/.test(trimmed)) song.year = Number(trimmed);
      else {
        keep(key, value);
        warnings.push(`#YEAR “${trimmed}” isn't a year. It was kept as it is.`);
      }
    } else if (key in TEXT_HEADERS) song[TEXT_HEADERS[key as keyof typeof TEXT_HEADERS]] = trimmed || null;
    else if (key in SINGER_HEADERS) {
      const index = SINGER_HEADERS[key]!;
      // `#P1` is the current name; `#DUETSINGERP1` only counts when there is no `#P1`.
      if (!key.startsWith("DUET") || !singerNames.has(index)) singerNames.set(index, trimmed);
    } else if (key in TIME_HEADERS) {
      const { field, unit } = TIME_HEADERS[key]!;
      const number = decimal(value);
      if (number === undefined) {
        keep(key, value);
        warnings.push(`#${key} “${trimmed}” isn't a number; it was kept as is.`);
      } else {
        song[field] =
          unit === "seconds" ? number : unit === "milliseconds" ? number / 1000 : ticksToSeconds(number, grid);
      }
    } else keep(key, value);
  }
  // `#AUTHOR` is an old name for `#CREATOR`. A different one next to `#CREATOR` stays as it is.
  const author = song.extraHeaders.findIndex(([key]) => key === "AUTHOR");
  if (author >= 0 && (song.creator === null || song.creator === song.extraHeaders[author]![1].trim())) {
    song.creator = song.extraHeaders[author]![1].trim();
    song.extraHeaders.splice(author, 1);
  }

  // Notes without a player marker sing as P1. Lines keep their order of first appearance.
  const singers = new Map<number, ChartSingerRow>();
  const lineRows = new Map<string, ChartLineRow>();
  const breaks = new Map(document.lineBreaks?.map((lineBreak) => [lineBreak.lineId, lineBreak]));
  const sorted = document.notes.toSorted((a, b) => (a.player ?? 1) - (b.player ?? 1) || a.start - b.start);
  for (const note of sorted) {
    const index = note.player ?? 1;
    let singer = singers.get(index);
    if (!singer) {
      singer = { index, name: singerNames.get(index) || null, lines: [] };
      singers.set(index, singer);
    }
    let line = lineRows.get(note.lineId);
    if (!line) {
      const lineBreak = breaks.get(note.lineId);
      line = { switchStart: lineBreak?.start ?? null, switchEnd: lineBreak?.end ?? null, notes: [] };
      lineRows.set(note.lineId, line);
      singer.lines.push(line);
    }
    line.notes.push({
      start: note.start,
      duration: note.duration,
      pitch: note.pitch,
      lyric: note.lyric,
      type: note.type,
    });
  }
  if (singers.size === 0) singers.set(1, { index: 1, name: singerNames.get(1) || null, lines: [] });
  // A break exactly where the default rule puts it is default timing: it follows the gap as notes are edited, and
  // exports the same.
  const tick = (seconds: number) => Math.round(secondsToTicks(seconds, grid));
  for (const singer of singers.values()) {
    singer.lines.forEach((line, i) => {
      const next = singer.lines[i + 1];
      if (!next || line.switchStart === null || line.switchEnd !== null) return;
      const lastEnd = Math.max(...line.notes.map((note) => tick(note.start + note.duration)));
      if (tick(line.switchStart) === defaultBreakTick(lastEnd, tick(next.notes[0]!.start), grid))
        line.switchStart = null;
    });
  }

  return { chart: { song, singers: [...singers.values()].toSorted((a, b) => a.index - b.index) }, warnings };
}

/** Formats a number for a header: no float noise ("1000", "-250.5", "123.45"). */
export function headerNumber(value: number): string {
  const text = String(Number(value.toPrecision(15)));
  return text.includes("e") ? value.toFixed(9).replace(/\.?0+$/, "") : text;
}

/**
 * The singers an export writes: the ones with notes. A duet whose second singer has none yet (being built in the
 * editor) is exported as a solo chart, so games don't see a singer with nothing to sing.
 */
export function singingSingers(chart: ProjectChart): ProjectChart["singers"] {
  return chart.singers.filter((singer) => singer.lines.some((line) => line.notes.length > 0));
}

/** What an export says when a singer is left out for having no notes. */
export function emptySingerWarnings(chart: ProjectChart): string[] {
  if (chart.singers.length < 2) return [];
  const singing = singingSingers(chart);
  return chart.singers
    .filter((singer) => !singing.includes(singer))
    .map((singer) => `${singer.name || `P${singer.index}`} has no notes, so the song is exported as a solo chart.`);
}

/** The media headers an export writes, by header name. */
export type MediaHeaders = Partial<Record<(typeof MEDIA_HEADERS)[number], string>>;

/**
 * The chart for an export: the song's headers (version 1.2.0, modelled headers in a fixed
 * order, then the extra headers in their original order) and its notes in seconds. The
 * serializer quantizes the notes to the BPM grid.
 */
export function projectToChart(chart: ProjectChart, mediaHeaders: MediaHeaders): ChartDocument {
  const { song } = chart;
  const grid: ChartGrid = { bpm: song.bpm, gap: song.gap * 1000 };
  const singing = singingSingers(chart);
  const duet = singing.length > 1;
  const metadata: Record<string, string> = { VERSION: "1.2.0" };
  const set = (key: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    metadata[key] = typeof value === "number" ? headerNumber(value) : value;
  };

  set("TITLE", song.title);
  set("ARTIST", song.artist);
  // A solo chart keeps P1's name, as it was imported; a lone P2's would name a singer the file doesn't have. A duet
  // must name both (v1 format), so an unnamed singer is called by their part, as usdb_syncer does.
  for (const singer of singing) {
    if (duet) set(`P${singer.index}`, singer.name?.trim() || `P${singer.index}`);
    else if (singer.index === 1) set("P1", singer.name);
  }
  set("LANGUAGE", song.language.join(", "));
  set("EDITION", song.edition);
  set("GENRE", song.genre);
  set("YEAR", song.year);
  set("CREATOR", song.creator);
  for (const key of MEDIA_HEADERS) set(key, mediaHeaders[key]);
  set("BPM", song.bpm);
  set("GAP", song.gap * 1000);
  set("VIDEOGAP", song.videoGap);
  set("START", song.start);
  // USDX reads #END as whole milliseconds and ignores one with decimals.
  set("END", song.end === null ? null : Math.round(song.end * 1000));
  set("PREVIEWSTART", song.previewStart);
  // Each medley header needs the other, and USDX drops both when the medley ends before it starts.
  if (song.medleyStart !== null && song.medleyEnd !== null) {
    const start = Math.round(secondsToTicks(song.medleyStart, grid));
    const end = Math.round(secondsToTicks(song.medleyEnd, grid));
    if (start < end) {
      set("MEDLEYSTARTBEAT", start);
      set("MEDLEYENDBEAT", end);
    }
  }
  for (const [key, value] of song.extraHeaders) {
    if (key in metadata || DROPPED_HEADERS.has(key)) continue;
    const tags = key === "VIDEO" ? parseMetaTags(value) : null;
    if (tags) set(key, formatMetaTags(sourceMetaTags(tags, song)));
    else metadata[key] = value;
  }

  const notes: ChartNote[] = [];
  const lineBreaks: ChartLineBreak[] = [];
  for (const singer of singing.length > 0 ? singing : chart.singers) {
    for (const [lineIndex, line] of singer.lines.entries()) {
      const lineId = `line-${singer.index}-${lineIndex}`;
      if (line.switchStart !== null) {
        lineBreaks.push({
          lineId,
          start: line.switchStart,
          ...(line.switchEnd === null ? {} : { end: line.switchEnd }),
        });
      }
      for (const [noteIndex, note] of line.notes.entries()) {
        notes.push({
          id: `${lineId}-${noteIndex}`,
          lineId,
          start: note.start,
          duration: note.duration,
          pitch: note.pitch,
          lyric: note.lyric,
          type: note.type,
          ...(duet ? { player: singer.index } : {}),
        });
      }
    }
  }
  return { version: 1, id: "export", metadata, notes, ...(lineBreaks.length > 0 ? { lineBreaks } : {}) };
}
