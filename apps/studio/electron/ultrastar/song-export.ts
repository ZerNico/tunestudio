import { randomUUID } from "node:crypto";

import { DocumentValidationError, serializeUltraStarWithDiagnostics, UltraStarError } from "@tunestudio/ultrastar";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

import { extensionOf, songFileName } from "../../src/lib/file-names";
import type { ExportResult, MediaRole } from "../../src/lib/native/types";
import { ChartUnreadable, type FileError, mapFileError, type ProjectDamaged, quoted } from "../errors";
import { readChart } from "../project/chart";
import { listMedia, type MediaRow, writeMediaToFile } from "../project/media";
import type { ProjectSession } from "../project/projects";
import { emptySingerWarnings, type MediaHeaders, projectToChart } from "./chart-mapping";
import { usdbText } from "./usdb";

/** The file name suffix and headers for each media role, as UltraStar song folders name them. */
const ROLE_FILES: Record<MediaRole, { suffix: string; headers: (keyof MediaHeaders)[] }> = {
  audio: { suffix: "", headers: ["AUDIO", "MP3"] },
  vocals: { suffix: " [VOC]", headers: ["VOCALS"] },
  instrumental: { suffix: " [INSTR]", headers: ["INSTRUMENTAL"] },
  video: { suffix: "", headers: ["VIDEO"] },
  cover: { suffix: " [CO]", headers: ["COVER"] },
  background: { suffix: " [BG]", headers: ["BACKGROUND"] },
};

/** The export's file names: `<base>.<ext>` and friends, unique even when audio and video share one. */
export function exportFileNames(base: string, media: Pick<MediaRow, "id" | "role" | "fileName">[]) {
  const names = new Map<number, string>();
  const taken = new Set([`${base}.txt`.toLowerCase()]);
  // One file per role; the first one added wins.
  const seen = new Set<MediaRole>();
  for (const row of media) {
    if (seen.has(row.role)) continue;
    seen.add(row.role);
    const extension = extensionOf(row.fileName);
    let name = `${base}${ROLE_FILES[row.role].suffix}${extension}`;
    if (taken.has(name.toLowerCase())) name = `${base} [${row.role.toUpperCase()}]${extension}`;
    taken.add(name.toLowerCase());
    names.set(row.id, name);
  }
  return names;
}

/** What an export writes: the chart's text and file names, and the media under their names. */
function prepareExport(session: ProjectSession) {
  return Effect.gen(function* () {
    const chart = yield* readChart(session.db);
    const base = songFileName(chart.song.artist, chart.song.title);
    const media = yield* listMedia(session.db);
    const names = exportFileNames(base, media);
    const headers: MediaHeaders = {};
    for (const row of media) {
      const name = names.get(row.id);
      if (!name) continue;
      for (const header of ROLE_FILES[row.role].headers) headers[header] = name;
    }

    const { text, warnings } = yield* Effect.try({
      try: () => serializeUltraStarWithDiagnostics(projectToChart(chart, headers)),
      catch: (error) =>
        new ChartUnreadable({
          message: `The chart can't be exported: ${
            error instanceof UltraStarError || error instanceof DocumentValidationError ? error.message : String(error)
          }`,
        }),
    });
    warnings.unshift(...emptySingerWarnings(chart));
    const textFile = `${base}.txt`;
    const files = media.flatMap((row) => {
      const name = names.get(row.id);
      return name ? [{ row, name }] : [];
    });
    return { base, text, textFile, files, warnings };
  });
}

/**
 * Writes the project as `<Artist> - <Title>/` in `folder`: the chart as UTF-8 (version 1.2.0)
 * and the media byte for byte. An existing folder is only replaced when `replace` is set;
 * everything is written to a hidden sibling first and moved into place at the end, so a failed
 * export leaves the old folder as it was.
 */
export function exportSong(
  session: ProjectSession,
  folder: string,
  replace: boolean,
): Effect.Effect<ExportResult, ChartUnreadable | ProjectDamaged | FileError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const { base, text, textFile, files, warnings } = yield* prepareExport(session);
    const target = paths.join(folder, base);
    const what = quoted(base);

    if (!replace && (yield* fs.exists(target).pipe(mapFileError(what, "check")))) {
      return { status: "exists", folder: target } satisfies ExportResult;
    }

    const id = randomUUID().slice(0, 8);
    const staging = paths.join(folder, `.${base}.export-${id}`);
    const previous = paths.join(folder, `.${base}.previous-${id}`);
    const removeStaging = fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore);

    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(staging).pipe(mapFileError(what, "create"));
      yield* fs.writeFileString(paths.join(staging, textFile), text).pipe(mapFileError(what, "write"));
      for (const { row, name } of files) yield* writeMediaToFile(session.db, row, paths.join(staging, name));
      const exists = yield* fs.exists(target).pipe(mapFileError(what, "check"));
      if (exists) yield* fs.rename(target, previous).pipe(mapFileError(what, "replace"));
      yield* fs.rename(staging, target).pipe(
        mapFileError(what, "write"),
        // Put the old folder back if the new one couldn't take its place.
        Effect.onError(() => (exists ? fs.rename(previous, target).pipe(Effect.ignore) : Effect.void)),
      );
      if (exists) yield* fs.remove(previous, { recursive: true }).pipe(Effect.ignore);
    }).pipe(Effect.onError(() => removeStaging));

    return {
      status: "exported",
      folder: target,
      files: [textFile, ...files.map((file) => file.name)],
      warnings,
    } satisfies ExportResult;
  });
}

/** Beside the song folder `syncSong` keeps: which song it holds and the checksum of each media file in it. */
const SyncedFiles = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    folder: Schema.String,
    files: Schema.Record(Schema.String, Schema.String),
  }),
);
const decodeSynced = Schema.decodeUnknownEffect(SyncedFiles);
const encodeSynced = Schema.encodeSync(SyncedFiles);
const SYNCED_FILE = ".exported.json";

/**
 * Makes `<Artist> - <Title>/` in `root` what `exportSong` would write, and removes everything else in `root`: Try in
 * game's folder, which keeps only the last try. Media already there from the last sync with the same checksum (and
 * size) are kept, so trying again only writes the chart and what changed.
 */
export function syncSong(
  session: ProjectSession,
  root: string,
): Effect.Effect<
  { folder: string; warnings: string[] },
  ChartUnreadable | ProjectDamaged | FileError,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const { base, text, textFile, files, warnings } = yield* prepareExport(session);
    const target = paths.join(root, base);
    const what = quoted(base);
    const record = paths.join(root, SYNCED_FILE);

    const synced = yield* fs.readFileString(record).pipe(Effect.flatMap(decodeSynced), Effect.option);
    const known = Option.match(synced, {
      onNone: (): Record<string, string> => ({}),
      onSome: (stored) => (stored.folder === base ? stored.files : {}),
    });
    // Until it is written again, nothing counts as synced: a sync cut short writes every file next time.
    yield* fs.remove(record, { force: true }).pipe(mapFileError(what, "replace"));
    yield* fs.makeDirectory(target, { recursive: true }).pipe(mapFileError(what, "create"));

    const remove = (path: string) =>
      fs.remove(path, { recursive: true, force: true }).pipe(mapFileError(what, "replace"));
    for (const entry of yield* fs.readDirectory(root).pipe(mapFileError(what, "replace"))) {
      if (entry !== base) yield* remove(paths.join(root, entry));
    }
    const wanted = new Set([textFile, ...files.map((file) => file.name)]);
    for (const entry of yield* fs.readDirectory(target).pipe(mapFileError(what, "replace"))) {
      if (!wanted.has(entry)) yield* remove(paths.join(target, entry));
    }

    yield* fs.writeFileString(paths.join(target, textFile), text).pipe(mapFileError(what, "write"));
    for (const { row, name } of files) {
      const file = paths.join(target, name);
      const size = yield* fs.stat(file).pipe(
        Effect.map((info) => (info.type === "File" ? Number(info.size) : null)),
        Effect.orElseSucceed(() => null),
      );
      if (known[name] === row.sha256 && size === row.size) continue;
      yield* remove(file);
      yield* writeMediaToFile(session.db, row, file);
    }
    yield* fs
      .writeFileString(
        record,
        encodeSynced({
          version: 1,
          folder: base,
          files: Object.fromEntries(files.map(({ row, name }) => [name, row.sha256])),
        }),
      )
      .pipe(mapFileError(what, "write"));
    return { folder: target, warnings };
  });
}

/**
 * Writes the chart's text for USDB to `file` (`usdb.ts`), naming the audio, cover and background as an export for
 * games would. Returns
 * what changed on the way (BPM rounded, no YouTube video).
 */
export function exportUsdb(
  session: ProjectSession,
  file: string,
): Effect.Effect<{ warnings: string[] }, ChartUnreadable | ProjectDamaged | FileError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const chart = yield* readChart(session.db);
    const base = songFileName(chart.song.artist, chart.song.title);
    const media = yield* listMedia(session.db);
    const names = exportFileNames(base, media);
    const nameOf = (role: MediaRole) => {
      const row = media.find((item) => item.role === role);
      return row ? (names.get(row.id) ?? null) : null;
    };
    const { text, warnings } = yield* Effect.try({
      try: () => usdbText(chart, { audio: nameOf("audio"), cover: nameOf("cover"), background: nameOf("background") }),
      catch: (error) =>
        new ChartUnreadable({
          message: `The chart can't be exported: ${
            error instanceof UltraStarError || error instanceof DocumentValidationError ? error.message : String(error)
          }`,
        }),
    });
    yield* fs.writeFileString(file, text).pipe(mapFileError(quoted(base), "write"));
    return { warnings };
  });
}
