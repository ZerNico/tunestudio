import { randomUUID } from "node:crypto";

import { DocumentValidationError, serializeUltraStarWithDiagnostics, UltraStarError } from "@tunestudio/ultrastar";
import { Effect, FileSystem, Path } from "effect";

import { extensionOf, songFileName } from "../../src/lib/file-names";
import type { ExportResult, MediaRole } from "../../src/lib/native/types";
import { ChartUnreadable, type FileError, mapFileError, type ProjectDamaged, quoted } from "../errors";
import { readChart } from "../project/chart";
import { listMedia, type MediaRow, writeMediaToFile } from "../project/media";
import type { ProjectSession } from "../project/projects";
import { type MediaHeaders, projectToChart } from "./chart-mapping";
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
    const chart = yield* readChart(session.db);
    const base = songFileName(chart.song.artist, chart.song.title);
    const target = paths.join(folder, base);
    const what = quoted(base);

    if (!replace && (yield* fs.exists(target).pipe(mapFileError(what, "check")))) {
      return { status: "exists", folder: target } satisfies ExportResult;
    }

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

    const id = randomUUID().slice(0, 8);
    const staging = paths.join(folder, `.${base}.export-${id}`);
    const previous = paths.join(folder, `.${base}.previous-${id}`);
    const removeStaging = fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore);

    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(staging).pipe(mapFileError(what, "create"));
      yield* fs.writeFileString(paths.join(staging, `${base}.txt`), text).pipe(mapFileError(what, "write"));
      for (const row of media) {
        const name = names.get(row.id);
        if (name) yield* writeMediaToFile(session.db, row, paths.join(staging, name));
      }
      const exists = yield* fs.exists(target).pipe(mapFileError(what, "check"));
      if (exists) yield* fs.rename(target, previous).pipe(mapFileError(what, "replace"));
      yield* fs.rename(staging, target).pipe(
        mapFileError(what, "write"),
        // Put the old folder back if the new one couldn't take its place.
        Effect.onError(() => (exists ? fs.rename(previous, target).pipe(Effect.ignore) : Effect.void)),
      );
      if (exists) yield* fs.remove(previous, { recursive: true }).pipe(Effect.ignore);
    }).pipe(Effect.onError(() => removeStaging));

    const files = [`${base}.txt`, ...media.flatMap((row) => names.get(row.id) ?? [])];
    return { status: "exported", folder: target, files, warnings } satisfies ExportResult;
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
