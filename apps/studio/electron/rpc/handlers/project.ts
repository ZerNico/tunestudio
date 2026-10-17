/** An open project: opening and closing it, the editor's reads and edits, its media, charting and export. */
import { Effect } from "effect";

import { languageName } from "../../../src/lib/languages";
import { autoPitchNotes } from "../../charting/project-auto-pitch";
import { chartProjectRange } from "../../charting/project-range-chart";
import { syllabify } from "../../charting/syllables";
import { setArtwork } from "../../project/artwork";
import { applyChartChanges } from "../../project/chart-changes";
import { readEditorChart } from "../../project/editor-chart";
import { projectOverview } from "../../project/overview";
import { sungPitch } from "../../project/pitch";
import { Projects } from "../../project/projects";
import { removeVideo, replaceSongMedia, separateSong } from "../../project/song-media";
import { waveform } from "../../project/waveform";
import { exportSong, exportUsdb } from "../../ultrastar/song-export";
import {
  allowedPath,
  Callers,
  grant,
  type GroupHandlers,
  openedIn,
  progressStream,
  project,
  windowOf,
  withProject,
} from "./shared";

export const projectHandlers = {
  "project.open": (input, { client }) =>
    Effect.gen(function* () {
      const path = yield* allowedPath(input.path);
      const window = yield* windowOf(client);
      const { windows } = yield* Callers;
      // Open in another window already: that one comes to the front, and this one stays as it is.
      const showing = windows?.showing(path, window);
      if (showing) {
        windows!.focus(showing);
        return { id: "", path, elsewhere: true };
      }
      const session = yield* Projects.use((projects) => projects.open(path));
      return yield* openedIn(client, session);
    }),
  "project.overview": (input) => withProject(input.id, projectOverview),
  "project.close": (input, { client }) =>
    Effect.gen(function* () {
      const window = yield* windowOf(client);
      const { windows } = yield* Callers;
      if (window) windows?.show(window, null);
      // Another window showing it (opened again from its start screen) keeps it open.
      if (windows?.showsSession(input.id)) return;
      yield* Projects.use((projects) => projects.close(input.id));
    }),
  "project.pitch": (input) =>
    progressStream((onProgress) => Effect.flatMap(project(input.id), (session) => sungPitch(session, onProgress))),
  "project.waveform": (input) => Effect.flatMap(project(input.id), waveform),
  "project.replaceMedia": (input) =>
    Effect.gen(function* () {
      const path = yield* allowedPath(input.path);
      const session = yield* project(input.id);
      yield* replaceSongMedia(session, input.role, path);
      return yield* projectOverview(session);
    }),
  "project.removeVideo": (input) =>
    withProject(input.id, (session) => Effect.andThen(removeVideo(session), projectOverview(session))),
  "project.separate": (input) =>
    progressStream((onProgress) =>
      Effect.flatMap(project(input.id), (session) =>
        Effect.andThen(separateSong(session, onProgress), projectOverview(session)),
      ),
    ),
  "project.setArtwork": (input) =>
    Effect.flatMap(project(input.id), (session) =>
      Effect.gen(function* () {
        // A picked file's path comes from the renderer: only one the user picked may be read.
        const choice =
          input.choice.kind === "file"
            ? { kind: "file" as const, path: yield* allowedPath(input.choice.path) }
            : input.choice;
        yield* setArtwork(session, input.role, choice);
        return yield* projectOverview(session);
      }),
    ),
  "project.applyChanges": (input) =>
    withProject(input.id, (session) =>
      // A save that started finishes even if its window closes meanwhile: stopped halfway, it would roll back.
      session.db.transaction((tx) => applyChartChanges(tx, input.changes)).pipe(Effect.uninterruptible),
    ),
  "project.autoPitch": (input) =>
    progressStream((onProgress) =>
      Effect.flatMap(project(input.id), (session) => autoPitchNotes(session, input.notes, onProgress)),
    ),
  "project.chartRange": (input) =>
    progressStream((onProgress) =>
      Effect.flatMap(project(input.id), (session) => chartProjectRange(session, input, onProgress)),
    ),
  "project.chart": (input) => withProject(input.id, (session) => readEditorChart(session.db)),
  "project.exportUsdb": (input) =>
    Effect.gen(function* () {
      const path = yield* allowedPath(input.path);
      return yield* withProject(input.id, (session) => exportUsdb(session, path));
    }),
  "project.exportSong": (input) =>
    Effect.gen(function* () {
      const folder = yield* allowedPath(input.folder);
      const result = yield* withProject(input.id, (session) => exportSong(session, folder, input.replace));
      yield* grant(result.folder);
      return result;
    }),
  "lyrics.syllabify": (input) =>
    Effect.sync(() => {
      // The syllable rules go by English language names ("german"); without one, the vowel rules.
      const language = input.language ? languageName(input.language).toLowerCase() : "";
      return input.words.map((word) => syllabify(word, language));
    }),
} satisfies GroupHandlers<"project" | "lyrics">;
