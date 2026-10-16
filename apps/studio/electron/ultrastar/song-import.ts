import {
  type ChartDocument,
  decodeChart,
  DocumentValidationError,
  parseUltraStar,
  UltraStarError,
} from "@tunestudio/ultrastar";
import { Effect, FileSystem, Option, Path } from "effect";

import { songFileName } from "../../src/lib/file-names";
import type { ImportProgress, MediaRole, SongInspection, SongMediaFile } from "../../src/lib/native/types";
import {
  ChartUnreadable,
  type DiskFull,
  type FileError,
  mapFileError,
  MissingMainAudio,
  NoChartFound,
  quoted,
} from "../errors";
import { writeChart } from "../project/chart";
import { orDiskFull, writeMeta } from "../project/database";
import { writeMedia } from "../project/media";
import { type OpenError, Projects, type ProjectSession } from "../project/projects";
import { chartToProject } from "./chart-mapping";
import { parseMetaTags, readMetaTags } from "./usdb";

/** Charts are text; anything bigger than this isn't one. */
const MAX_CHART_SIZE = 8 * 1024 * 1024;

/** The headers naming each media role. The first one present wins (`#AUDIO` before `#MP3`). */
const ROLE_HEADERS: [MediaRole, string[]][] = [
  ["audio", ["AUDIO", "MP3"]],
  ["vocals", ["VOCALS"]],
  ["instrumental", ["INSTRUMENTAL"]],
  ["video", ["VIDEO"]],
  ["cover", ["COVER"]],
  ["background", ["BACKGROUND"]],
];

const ROLE_NAMES: Record<MediaRole, string> = {
  audio: "audio",
  vocals: "vocals",
  instrumental: "instrumental",
  video: "video",
  cover: "cover",
  background: "background",
};

/** A media file the chart names, resolved in its song folder. */
export interface SourceMedia extends SongMediaFile {
  /** The absolute path, when the file was found inside the folder. */
  path?: string;
}

/** A song folder, read and parsed, before anything is written. */
export interface SongSource {
  folder: string;
  chart: string;
  charts: string[];
  document: ChartDocument;
  media: SourceMedia[];
  /** Header values kept verbatim because they aren't file names (`#VIDEO:v=...` from USDB). */
  keptHeaders: [string, string][];
  warnings: string[];
}

type InspectError = NoChartFound | ChartUnreadable | FileError;

function isChart(name: string) {
  return name.toLowerCase().endsWith(".txt") && !name.startsWith(".");
}

/** A `#VIDEO` value that is metadata (`v=abc,co=...`) rather than a file name. */
function isVideoMetadata(value: string) {
  return value.includes("=") || !/\.[a-z0-9]{2,5}$/i.test(value);
}

/**
 * Reads a song folder, or the folder of a `.txt` chart: decodes and parses the chart and finds
 * the media it names. Only files inside the folder are looked at; nothing is written.
 */
export function inspectSong(
  input: string,
  chartName?: string,
): Effect.Effect<SongSource, InspectError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const absolute = paths.resolve(input);
    const info = yield* fs.stat(absolute).pipe(mapFileError(quoted(paths.basename(absolute)), "open"));
    const isFolder = info.type === "Directory";
    const folder = yield* fs
      .realPath(isFolder ? absolute : paths.dirname(absolute))
      .pipe(mapFileError(quoted(paths.basename(absolute)), "open"));

    const entries = yield* fs.readDirectory(folder).pipe(mapFileError(quoted(paths.basename(folder)), "read"));
    const charts = entries.filter(isChart).toSorted((a, b) => a.localeCompare(b));
    const chart = chartName ?? (isFolder ? defaultChart(charts, paths.basename(folder)) : paths.basename(absolute));
    if (!chart || !charts.includes(chart)) {
      return yield* new NoChartFound({
        message: chartName
          ? `There is no chart called ${quoted(chartName)} in ${quoted(paths.basename(folder))}.`
          : `${quoted(paths.basename(folder))} has no UltraStar chart (.txt file).`,
      });
    }

    const chartPath = paths.join(folder, chart);
    const chartInfo = yield* fs.stat(chartPath).pipe(mapFileError(quoted(chart), "read"));
    if (chartInfo.type !== "File" || Number(chartInfo.size) > MAX_CHART_SIZE) {
      return yield* new ChartUnreadable({ message: `${quoted(chart)} is too big to be an UltraStar chart.` });
    }
    const bytes = yield* fs.readFile(chartPath).pipe(mapFileError(quoted(chart), "read"));
    const parsed = yield* Effect.try({
      try: () => parseUltraStar(decodeChart(bytes)),
      catch: (error) =>
        new ChartUnreadable({
          message: `Couldn't read ${quoted(chart)}: ${
            error instanceof UltraStarError || error instanceof DocumentValidationError ? error.message : String(error)
          }`,
        }),
    });

    const media: SourceMedia[] = [];
    const keptHeaders: [string, string][] = [];
    const warnings = [...parsed.warnings];
    const metadata = parsed.document.metadata;
    for (const [role, headers] of ROLE_HEADERS) {
      const header = headers.find((key) => metadata[key]?.trim());
      if (!header) continue;
      const value = metadata[header]!;
      const fileName = value.trim();
      const resolved = yield* resolveInFolder(folder, fileName);
      if (role === "video" && resolved.status !== "found" && isVideoMetadata(fileName)) {
        keptHeaders.push([header, value]);
        continue;
      }
      if (resolved.status === "found") {
        media.push({
          role,
          fileName: paths.basename(resolved.path),
          size: resolved.size,
          found: true,
          path: resolved.path,
        });
        continue;
      }
      media.push({ role, fileName, found: false });
      if (role === "audio") continue;
      warnings.push(
        resolved.status === "outside"
          ? `The ${ROLE_NAMES[role]} ${quoted(fileName)} is outside the song folder, so it isn't imported.`
          : `The ${ROLE_NAMES[role]} ${quoted(fileName)} is missing, so it isn't imported.`,
      );
    }
    return { folder, chart, charts, document: parsed.document, media, keptHeaders, warnings };
  });
}

/** The chart to import when the user didn't pick one: the only one, or the one named like the folder. */
function defaultChart(charts: string[], folderName: string): string | undefined {
  if (charts.length <= 1) return charts[0];
  return charts.find((chart) => chart.slice(0, -4).toLowerCase() === folderName.toLowerCase()) ?? charts[0];
}

type Resolved = { status: "found"; path: string; size: number } | { status: "missing" } | { status: "outside" };

/** Finds `fileName` inside `folder`; symlinks and `..` that lead outside it don't count. */
function resolveInFolder(folder: string, fileName: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    if (!fileName || paths.isAbsolute(fileName) || /^[a-z][a-z0-9+.-]*:/i.test(fileName)) {
      return { status: "outside" } satisfies Resolved as Resolved;
    }
    const candidate = paths.resolve(folder, fileName.replaceAll("\\", "/"));
    const real = yield* fs.realPath(candidate).pipe(Effect.option);
    if (Option.isNone(real)) {
      return (isInside(paths, folder, candidate) ? { status: "missing" } : { status: "outside" }) as Resolved;
    }
    if (!isInside(paths, folder, real.value)) return { status: "outside" } as Resolved;
    const info = yield* fs.stat(real.value).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return { status: "missing" } as Resolved;
    return { status: "found", path: real.value, size: Number(info.value.size) } as Resolved;
  });
}

function isInside(paths: Path.Path, folder: string, path: string) {
  const relative = paths.relative(folder, path);
  return relative !== "" && !relative.startsWith("..") && !paths.isAbsolute(relative);
}

/** What the import dialog shows about a song source. */
export function describeSong(source: SongSource): SongInspection {
  const metadata = source.document.metadata;
  const title = metadata.TITLE?.trim() ?? "";
  const artist = metadata.ARTIST?.trim() ?? "";
  const audio = source.media.find((file) => file.role === "audio");
  return {
    folder: source.folder,
    chart: source.chart,
    charts: source.charts,
    title,
    artist,
    notes: source.document.notes.length,
    singers: Math.max(1, new Set(source.document.notes.map((note) => note.player ?? 1)).size),
    media: source.media.map(({ path: _path, ...file }) => file),
    warnings: source.warnings,
    blocker: mainAudioProblem(audio),
    suggestedName: songFileName(artist, title),
  };
}

function mainAudioProblem(audio: SourceMedia | undefined): string | null {
  if (!audio) return "The chart doesn't name an audio file (#AUDIO or #MP3), so there is nothing to sing along to.";
  if (!audio.found) return `The audio file ${quoted(audio.fileName)} is missing from the song folder.`;
  return null;
}

export interface ImportOptions {
  includeVideo: boolean;
  /** The `.tunestudio` file to write. */
  target: string;
}

/**
 * Writes a song source into a new project at `options.target` and opens it. The media is
 * copied byte for byte; `onProgress` reports what is being written.
 */
export function importSong(
  source: SongSource,
  options: ImportOptions,
  onProgress: (progress: ImportProgress) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<
  ProjectSession,
  MissingMainAudio | ChartUnreadable | OpenError | DiskFull | FileError,
  Projects | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const projects = yield* Projects;
    const audio = source.media.find((file) => file.role === "audio");
    const problem = mainAudioProblem(audio);
    if (problem) return yield* new MissingMainAudio({ message: problem });

    const files = source.media.filter(
      (file): file is SourceMedia & { path: string } =>
        file.found && file.path !== undefined && (options.includeVideo || file.role !== "video"),
    );
    const total = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
    const { chart, warnings: mappingWarnings } = yield* Effect.try({
      try: () => chartToProject(source.document),
      catch: (error) => new ChartUnreadable({ message: `Couldn't read ${quoted(source.chart)}: ${String(error)}` }),
    });
    chart.song.extraHeaders.push(...source.keptHeaders);
    // A USDB chart keeps its YouTube video, preview, medley and more in usdb_syncer's meta tags (`#VIDEO:v=…`).
    const metaTags = source.keptHeaders.find(([key]) => key === "VIDEO")?.[1];
    if (metaTags) readMetaTags(chart, parseMetaTags(metaTags) ?? []);
    const warnings = [...source.warnings, ...mappingWarnings];

    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    return yield* projects.create(options.target, (db) =>
      Effect.gen(function* () {
        yield* onProgress({ step: `Reading ${source.chart}`, done: 0, total });
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* writeChart(tx, chart);
              yield* writeMeta(tx, {
                imported_from: paths.join(source.folder, source.chart),
                import_warnings: JSON.stringify(warnings),
              });
            }),
          )
          .pipe(orDiskFull);
        let done = 0;
        for (const file of files) {
          const before = done;
          yield* writeMedia(
            db,
            { path: file.path, role: file.role, fileName: file.fileName, source: "imported" },
            (written) => onProgress({ step: `Copying ${file.fileName}`, done: before + written, total }),
          ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          done += file.size ?? 0;
        }
        yield* onProgress({ step: "Finishing", done: total, total });
      }),
    );
  });
}
