/**
 * USDB (usdb.animux.de), the community's chart database, and usdb_syncer, which downloads its charts with their media.
 * A chart for USDB is its text alone, pasted into USDB's form: the headers usdb_syncer submits (no `#VERSION`, no
 * file names but the audio's), BPM with two decimals, GAP in whole milliseconds, CRLF line ends. Where the song's media
 * are, and what USDB would drop (preview, medley, duet singers, tags), go in usdb_syncer's meta tags in `#VIDEO`
 * (`v=<YouTube id>,co=<cover>,preview=…`). See usdb_syncer's `meta_tags.py` and `song_txt/headers.py`.
 */
import {
  type ChartDocument,
  secondsToTicks,
  serializeUltraStarWithDiagnostics,
  ticksToSeconds,
} from "@tunestudio/ultrastar";

import { parseYoutubeVideoId } from "../../src/lib/youtube";
import { headerNumber, type ProjectChart, projectToChart } from "./chart-mapping";

/** usdb_syncer's meta tags, as `[key, value]` pairs in order. */
export type MetaTags = [string, string][];

/** The meta tags in a `#VIDEO` value, or null when it is a file name (it has no `=`). */
export function parseMetaTags(value: string): MetaTags | null {
  if (!value.includes("=")) return null;
  return value
    .split(",")
    .filter((part) => part.includes("="))
    .map((part) => {
      const at = part.indexOf("=");
      return [
        part.slice(0, at).trim().toLowerCase(),
        part
          .slice(at + 1)
          .trim()
          .replaceAll("%2C", ","),
      ];
    });
}

/** Meta tags as a `#VIDEO` value: commas in values written as `%2C`. */
export function formatMetaTags(tags: MetaTags): string {
  return tags.map(([key, value]) => `${key}=${value.replaceAll(",", "%2C")}`).join(",");
}

/** The YouTube video meta tags name for the song (`v`, else the audio-only `a`), as an id; null for none. */
export function youtubeIdOf(tags: MetaTags): string | null {
  for (const key of ["v", "a"]) {
    const value = tags.find(([name]) => name === key)?.[1];
    if (!value) continue;
    const id = /^[\w-]{11}$/.test(value) ? value : parseYoutubeVideoId(value);
    if (id) return id;
  }
  return null;
}

/**
 * What a USDB chart keeps in its meta tags (USDB drops these headers) as the song's own: its YouTube video, preview,
 * medley, duet singers' names and tags, where the chart's headers don't say. Changes `chart` in place.
 */
export function readMetaTags(chart: ProjectChart, tags: MetaTags): void {
  const { song } = chart;
  const value = (key: string) => tags.find(([name]) => name === key)?.[1];
  song.youtubeId ??= youtubeIdOf(tags);
  const preview = Number(value("preview"));
  if (song.previewStart === null && value("preview") && Number.isFinite(preview)) song.previewStart = preview;
  const medley = /^(\d+)-(\d+)$/.exec(value("medley") ?? "");
  if (medley && song.medleyStart === null && song.medleyEnd === null) {
    const grid = { bpm: song.bpm, gap: song.gap * 1000 };
    song.medleyStart = ticksToSeconds(Number(medley[1]), grid);
    song.medleyEnd = ticksToSeconds(Number(medley[2]), grid);
  }
  for (const singer of chart.singers) singer.name ??= value(`p${singer.index}`) ?? null;
  const songTags = value("tags");
  if (songTags && !song.extraHeaders.some(([key]) => key === "TAGS")) {
    song.extraHeaders.push([
      "TAGS",
      songTags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .join(", "),
    ]);
  }
}

/** The order usdb_syncer writes meta tags in; others it doesn't know go after them. */
const META_ORDER = ["a", "v", "v-trim", "v-crop", "co", "co-rotate", "co-crop", "co-resize", "co-contrast", "bg"];
const META_LAST = ["bg-crop", "bg-resize", "p1", "p2", "preview", "medley", "tags"];

/** Where a meta tag goes in usdb_syncer's order. */
function rank(key: string): number {
  const first = META_ORDER.indexOf(key);
  if (first >= 0) return first;
  const last = META_LAST.indexOf(key);
  return last >= 0 ? META_ORDER.length + 1 + last : META_ORDER.length;
}

function sortTags(tags: MetaTags): MetaTags {
  return tags.toSorted((a, b) => rank(a[0]) - rank(b[0]));
}

/** USDB's BPM: at most two decimals. */
export function usdbBpm(bpm: number): number {
  return Math.round(bpm * 100) / 100;
}

/** The media file names a chart for USDB names (as an export for games names them), null where there is none. */
export interface UsdbFiles {
  audio: string | null;
  cover: string | null;
  background: string | null;
}

/**
 * The chart's text for USDB, with `files` as `#MP3`, `#COVER` and `#BACKGROUND`. The song's own meta tags (kept from a USDB
 * import) stay, with its YouTube video, preview, medley, duet singers and tags set from the song. `warnings` says what
 * USDB will miss.
 */
export function usdbText(chart: ProjectChart, files: UsdbFiles): { text: string; warnings: string[] } {
  const { song } = chart;
  const warnings: string[] = [];
  const bpm = usdbBpm(song.bpm);
  const gap = Math.round(song.gap * 1000);
  const grid = { bpm, gap };
  const duet = chart.singers.length > 1;

  // Meta tags kept from a USDB import (covers, crops); the song's own fields replace theirs.
  const kept = song.extraHeaders.find(([key]) => key === "VIDEO")?.[1];
  const imported = kept ? (parseMetaTags(kept) ?? []) : [];
  const own = new Set(["a", "v", "preview", "medley", "p1", "p2", "tags"]);
  const tags: MetaTags = imported.filter(([key]) => !own.has(key));
  // The song's video gives the audio too (`v`); without one, an audio-only source it came with stays.
  const audioOnly = imported.find(([key]) => key === "a")?.[1];
  if (song.youtubeId) tags.push(["v", song.youtubeId]);
  else if (audioOnly) tags.push(["a", audioOnly]);
  else warnings.push("The song has no YouTube video.");
  for (const singer of chart.singers) if (duet && singer.name) tags.push([`p${singer.index}`, singer.name]);
  if (song.previewStart !== null) tags.push(["preview", headerNumber(Math.round(song.previewStart * 1000) / 1000)]);
  if (song.medleyStart !== null && song.medleyEnd !== null) {
    const beat = (seconds: number) => Math.round(secondsToTicks(seconds, grid));
    tags.push(["medley", `${beat(song.medleyStart)}-${beat(song.medleyEnd)}`]);
  }
  const songTags = song.extraHeaders.find(([key]) => key === "TAGS")?.[1]?.trim();
  if (songTags) {
    tags.push([
      "tags",
      songTags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .join(","),
    ]);
  }

  const title = duet && !/\[DUET\]/i.test(song.title) ? `${song.title} [DUET]` : song.title;
  const metadata: Record<string, string> = {};
  const set = (key: string, value: string | number | null) => {
    if (value === null || value === "") return;
    metadata[key] = typeof value === "number" ? headerNumber(value) : value;
  };
  set("ARTIST", song.artist);
  set("TITLE", title);
  set("MP3", files.audio);
  set("CREATOR", song.creator);
  set("EDITION", song.edition);
  set("COVER", files.cover);
  set("BACKGROUND", files.background);
  set("GENRE", song.genre);
  set("YEAR", song.year);
  set("LANGUAGE", song.language.join(", "));
  set("BPM", bpm);
  set("GAP", gap);
  set("VIDEO", tags.length > 0 ? formatMetaTags(sortTags(tags)) : null);
  set("VIDEOGAP", song.videoGap);
  set("START", song.start);
  set("END", song.end === null ? null : Math.round(song.end * 1000));

  // The notes in seconds, put on the USDB grid as they are written.
  const document: ChartDocument = { ...projectToChart(chart, {}), metadata };
  const result = serializeUltraStarWithDiagnostics(document);
  // As USDB hands charts out: CRLF, and nothing after the E.
  return { text: result.text.trimEnd().replaceAll("\n", "\r\n"), warnings };
}
