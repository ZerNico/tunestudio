/**
 * USDB (usdb.animux.de), the community's chart database, and usdb_syncer, which downloads its charts with their media.
 * A chart for USDB is its text alone, pasted into USDB's form: the headers usdb_syncer submits (no `#VERSION`, no
 * file names but the audio's), BPM with two decimals, GAP in whole milliseconds, CRLF line ends. Where the song's media
 * are, and what USDB would drop (preview, medley, duet singers, tags), go in usdb_syncer's meta tags in `#VIDEO`
 * (`v=<YouTube id>,co=<cover>,preview=…`). See usdb_syncer's `meta_tags.py` and `song_txt/headers.py`.
 */
import { type ChartDocument, secondsToTicks, serializeUltraStarWithDiagnostics } from "@tunestudio/ultrastar";

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

/**
 * The chart's text for USDB, with `audioFile` as `#MP3` (null: none). The song's own meta tags (kept from a USDB
 * import) stay, with its YouTube video, preview, medley, duet singers and tags set from the song. `warnings` says what
 * changed on the way.
 */
export function usdbText(chart: ProjectChart, audioFile: string | null): { text: string; warnings: string[] } {
  const { song } = chart;
  const warnings: string[] = [];
  const bpm = usdbBpm(song.bpm);
  const gap = Math.round(song.gap * 1000);
  if (bpm !== song.bpm || gap !== song.gap * 1000) {
    warnings.push(
      `USDB takes BPM with two decimals and GAP in whole milliseconds (${headerNumber(bpm)} BPM, ${gap} ms), so notes may move by a few milliseconds.`,
    );
  }
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
  else warnings.push("The song has no YouTube video, so usdb_syncer can't download its audio. Add it in Song details.");
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
  set("MP3", audioFile);
  set("CREATOR", song.creator);
  set("EDITION", song.edition);
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
  return { text: result.text.replaceAll("\n", "\r\n"), warnings: [...warnings, ...result.warnings] };
}
