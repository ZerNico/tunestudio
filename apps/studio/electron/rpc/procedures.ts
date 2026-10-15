import { Effect, FileSystem, type ManagedRuntime, Path } from "effect";

import { safeFileName } from "../../src/lib/file-names";
import type { ChosenImage, OpenedProject, RecentProjectEntry } from "../../src/lib/native/types";
import { generateChart } from "../charting/generate";
import { createDraftProject, listenToDraft, makeDraftChart } from "../drafts/draft-project";
import { ImageUnreadable } from "../errors";
import { downloadFeature, modelFeatures, removeFeature } from "../models/features";
import { CHART_MODELS, type ModelName, Models } from "../models/models";
import { readEditorChart } from "../project/editor-chart";
import { readImage } from "../project/images";
import { projectOverview, recentEntry } from "../project/overview";
import { sungPitch } from "../project/pitch";
import { Projects, type ProjectSession } from "../project/projects";
import { AppLog } from "../services/app-log";
import { Desktop } from "../services/desktop";
import { Drafts } from "../services/drafts";
import type { StudioServices } from "../services/layer";
import { normalizePath, notAllowed, PathGrants } from "../services/path-grants";
import { Recents } from "../services/recents";
import { AppSettings } from "../services/settings";
import { Tools } from "../tools/tools";
import { exportSong } from "../ultrastar/song-export";
import { describeSong, importSong, inspectSong } from "../ultrastar/song-import";
import { findCovers } from "../youtube/covers";
import { findLyrics } from "../youtube/lyrics";
import { inspectVideo } from "../youtube/youtube";
import { downloadIntoDraft } from "../youtube/youtube-draft";
import { os, runRpc } from "./base";

/** The default folder for new projects, under the user's Music folder. */
export const PROJECTS_FOLDER = "Tune Studio";

/** `path`, if the user picked or dropped it in this session (or it is a listed recent project). */
const allowedPath = (path: string) =>
  Effect.gen(function* () {
    const grants = yield* PathGrants;
    if (!(yield* grants.allows(path))) return yield* notAllowed();
    return normalizePath(path);
  });

const grant = (path: string | null) =>
  path === null
    ? Effect.succeed(null)
    : Effect.as(
        PathGrants.use((grants) => grants.grant(path)),
        path,
      );

/** Puts an opened project at the top of the recents; failing to save the list doesn't stop the open. */
const remember = (session: ProjectSession) =>
  Effect.gen(function* () {
    const desktop = yield* Desktop;
    const recents = yield* Recents;
    const entry = yield* recentEntry(session, desktop.thumbnail).pipe(Effect.orElseSucceed(() => null));
    if (entry) {
      yield* recents
        .add(entry)
        .pipe(Effect.catch((error) => AppLog.use((log) => log.write("WARN", "recents", error.message))));
    }
    yield* PathGrants.use((grants) => grants.grant(session.path));
    return { id: session.id, path: session.path } satisfies OpenedProject;
  });

/**
 * Runs long work (an import, tool downloads), yielding its progress as it goes and returning its
 * result. Stopping the iteration (the renderer cancelled) interrupts the work, which cleans up after itself.
 * Work that finished anyway, with a result the renderer never got, is handed to `onUndelivered`.
 */
export async function* withProgress<P, A>(
  start: (onProgress: (progress: P) => Effect.Effect<void>, signal: AbortSignal) => Promise<A>,
  signal: AbortSignal | undefined,
  onUndelivered?: (result: A) => void,
): AsyncGenerator<P, A> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  // A cancel can arrive before the handler runs; the listener alone would never hear it.
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort);
  const queue: P[] = [];
  let wake: (() => void) | undefined;
  let outcome: { ok: true; value: A } | { ok: false; error: unknown } | undefined;
  let delivered = false;
  let abandoned = false;
  start(
    (progress) =>
      Effect.sync(() => {
        queue.push(progress);
        wake?.();
      }),
    controller.signal,
  )
    .then(
      (value) => {
        outcome = { ok: true, value };
        if (abandoned) onUndelivered?.(value);
      },
      (error: unknown) => (outcome = { ok: false, error }),
    )
    .finally(() => wake?.());
  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (outcome) break;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
    if (!outcome.ok) throw outcome.error;
    // A cancelled call's result is dropped on the way.
    delivered = !signal?.aborted;
    return outcome.value;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!delivered) {
      abandoned = true;
      if (outcome?.ok) onUndelivered?.(outcome.value);
    }
    if (!outcome) controller.abort();
  }
}

/**
 * The procedures behind the contract; each one runs an Effect on the main process runtime.
 * Every path from the renderer goes through `allowedPath` first.
 */
export function procedures(runtime: ManagedRuntime.ManagedRuntime<StudioServices, never>) {
  return {
    app: {
      log: os.app.log.handler(({ input, signal }) =>
        runRpc(
          runtime,
          AppLog.use((log) => log.write(input.level.toUpperCase(), "renderer", input.message)),
          signal,
        ),
      ),
    },

    dialogs: {
      chooseSong: os.dialogs.chooseSong.handler(({ context, signal }) =>
        runRpc(
          runtime,
          Effect.flatMap(
            Desktop.use((desktop) => desktop.chooseSong(context.window)),
            grant,
          ),
          signal,
        ),
      ),
      chooseProject: os.dialogs.chooseProject.handler(({ context, signal }) =>
        runRpc(
          runtime,
          Effect.flatMap(
            Desktop.use((desktop) => desktop.chooseProject(context.window)),
            grant,
          ),
          signal,
        ),
      ),
      chooseCoverImage: os.dialogs.chooseCoverImage.handler(({ context, signal }) =>
        runRpc(
          runtime,
          Effect.gen(function* () {
            const desktop = yield* Desktop;
            const path = yield* grant(yield* desktop.chooseImage(context.window));
            if (path === null) return null;
            const { bytes } = yield* readImage(path);
            const preview = yield* desktop.thumbnail(bytes);
            if (!preview) return yield* new ImageUnreadable({ message: "This image couldn't be read." });
            return { path, preview } satisfies ChosenImage;
          }),
          signal,
        ),
      ),
      chooseProjectLocation: os.dialogs.chooseProjectLocation.handler(({ input, context, signal }) =>
        runRpc(
          runtime,
          Effect.gen(function* () {
            const desktop = yield* Desktop;
            const fs = yield* FileSystem.FileSystem;
            const paths = yield* Path.Path;
            const folder = paths.join(desktop.musicFolder, PROJECTS_FOLDER);
            // The suggested folder has to exist for the dialog to start in it.
            yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.ignore);
            const chosen = yield* desktop.chooseProjectLocation(
              context.window,
              paths.join(folder, `${safeFileName(input.name)}.tunestudio`),
            );
            if (!chosen) return null;
            return yield* grant(chosen.toLowerCase().endsWith(".tunestudio") ? chosen : `${chosen}.tunestudio`);
          }),
          signal,
        ),
      ),
      chooseExportFolder: os.dialogs.chooseExportFolder.handler(({ context, signal }) =>
        runRpc(
          runtime,
          Effect.flatMap(
            Desktop.use((desktop) => desktop.chooseExportFolder(context.window, desktop.musicFolder)),
            grant,
          ),
          signal,
        ),
      ),
    },

    song: {
      inspect: os.song.inspect.handler(({ input, signal }) =>
        runRpc(
          runtime,
          Effect.flatMap(allowedPath(input.path), (path) => Effect.map(inspectSong(path, input.chart), describeSong)),
          signal,
        ),
      ),
      import: os.song.import.handler(({ input, signal }) =>
        withProgress(
          (onProgress, importSignal) =>
            runRpc(
              runtime,
              Effect.gen(function* () {
                const path = yield* allowedPath(input.path);
                const target = yield* allowedPath(input.target);
                const source = yield* inspectSong(path, input.chart);
                const session = yield* importSong(source, { includeVideo: input.includeVideo, target }, onProgress);
                return yield* remember(session);
              }),
              importSignal,
            ),
          signal,
        ),
      ),
    },

    project: {
      open: os.project.open.handler(({ input, signal }) =>
        runRpc(
          runtime,
          Effect.gen(function* () {
            const path = yield* allowedPath(input.path);
            const session = yield* Projects.use((projects) => projects.open(path));
            return yield* remember(session);
          }),
          signal,
        ),
      ),
      overview: os.project.overview.handler(({ input, signal }) =>
        runRpc(
          runtime,
          Effect.flatMap(
            Projects.use((projects) => projects.get(input.id)),
            projectOverview,
          ),
          signal,
        ),
      ),
      pitch: os.project.pitch.handler(({ input, signal }) =>
        withProgress(
          (onProgress, pitchSignal) =>
            runRpc(
              runtime,
              Effect.flatMap(
                Projects.use((projects) => projects.get(input.id)),
                (session) => sungPitch(session, onProgress),
              ),
              pitchSignal,
            ),
          signal,
        ),
      ),
      chart: os.project.chart.handler(({ input, signal }) =>
        runRpc(
          runtime,
          Effect.flatMap(
            Projects.use((projects) => projects.get(input.id)),
            (session) => readEditorChart(session.db),
          ),
          signal,
        ),
      ),
      close: os.project.close.handler(({ input, signal }) =>
        runRpc(
          runtime,
          Projects.use((projects) => projects.close(input.id)),
          signal,
        ),
      ),
      exportSong: os.project.exportSong.handler(({ input, signal }) =>
        runRpc(
          runtime,
          Effect.gen(function* () {
            const folder = yield* allowedPath(input.folder);
            const session = yield* Projects.use((projects) => projects.get(input.id));
            const result = yield* exportSong(session, folder, input.replace);
            yield* grant(result.folder);
            return result;
          }),
          signal,
        ),
      ),
      makeChart: os.project.makeChart.handler(({ input, signal }) =>
        withProgress(
          (onProgress, chartSignal) =>
            runRpc(
              runtime,
              Effect.gen(function* () {
                const session = yield* Projects.use((projects) => projects.get(input.id));
                yield* generateChart(session, onProgress);
                return yield* projectOverview(session);
              }),
              chartSignal,
            ),
          signal,
        ),
      ),
    },

    recents: {
      list: os.recents.list.handler(({ signal }) =>
        runRpc(
          runtime,
          Effect.gen(function* () {
            const projects = yield* Recents.use((recents) => recents.list);
            // The listed projects may be opened, revealed or restored after removing them.
            yield* Effect.forEach(projects, (project) => grant(project.path), { discard: true });
            return projects;
          }),
          signal,
        ),
      ),
      remove: os.recents.remove.handler(({ input, signal }) =>
        runRpc(
          runtime,
          Recents.use((recents) => recents.remove(normalizePath(input.path))),
          signal,
        ),
      ),
      restore: os.recents.restore.handler(({ input, signal }) =>
        runRpc(
          runtime,
          Effect.flatMap(allowedPath(input.path), (path) =>
            Recents.use((recents) => recents.restore({ ...input, path } satisfies RecentProjectEntry)),
          ),
          signal,
        ),
      ),
    },

    files: {
      reveal: os.files.reveal.handler(({ input, signal }) =>
        runRpc(
          runtime,
          Effect.flatMap(allowedPath(input.path), (path) => Desktop.use((desktop) => desktop.reveal(path))),
          signal,
        ),
      ),
    },

    youtube: {
      inspect: os.youtube.inspect.handler(({ input, signal }) => runRpc(runtime, inspectVideo(input.videoId), signal)),
      findCovers: os.youtube.findCovers.handler(({ input, signal }) => runRpc(runtime, findCovers(input), signal)),
      findLyrics: os.youtube.findLyrics.handler(({ input, signal }) => runRpc(runtime, findLyrics(input), signal)),
      download: os.youtube.download.handler(({ input, signal }) =>
        withProgress(
          (onProgress, downloadSignal) => runRpc(runtime, downloadIntoDraft(input.videoId, onProgress), downloadSignal),
          signal,
          // Cancelled just as it finished: the renderer won't hear of this draft to discard it.
          (draft) => void runtime.runPromise(Drafts.use((drafts) => drafts.discard(draft.draftId))).catch(() => {}),
        ),
      ),
    },

    drafts: {
      listen: os.drafts.listen.handler(({ input, signal }) =>
        withProgress(
          (onProgress, listenSignal) =>
            runRpc(
              runtime,
              listenToDraft(input.draftId, { language: input.language, mixed: input.mixed }, onProgress),
              listenSignal,
            ),
          signal,
        ),
      ),
      makeChart: os.drafts.makeChart.handler(({ input, signal }) =>
        withProgress(
          (onProgress, chartSignal) => runRpc(runtime, makeDraftChart(input, onProgress), chartSignal),
          signal,
        ),
      ),
      create: os.drafts.create.handler(({ input, signal }) =>
        withProgress(
          (onProgress, createSignal) =>
            runRpc(
              runtime,
              Effect.gen(function* () {
                const target = yield* allowedPath(input.target);
                const cover =
                  input.cover.kind === "file"
                    ? { kind: "file" as const, path: yield* allowedPath(input.cover.path) }
                    : input.cover;
                const session = yield* createDraftProject({ ...input, cover, target }, onProgress);
                return yield* remember(session);
              }),
              createSignal,
            ),
          signal,
        ),
      ),
      discard: os.drafts.discard.handler(({ input, signal }) =>
        runRpc(
          runtime,
          Drafts.use((drafts) => drafts.discard(input.draftId)),
          signal,
        ),
      ),
    },

    settings: {
      get: os.settings.get.handler(({ signal }) =>
        runRpc(
          runtime,
          AppSettings.use((settings) => settings.get),
          signal,
        ),
      ),
      set: os.settings.set.handler(({ input, signal }) =>
        runRpc(
          runtime,
          AppSettings.use((settings) => settings.set(input)),
          signal,
        ),
      ),
    },

    models: {
      status: os.models.status.handler(({ signal }) =>
        runRpc(
          runtime,
          Effect.gen(function* () {
            const models = yield* Models;
            const has = (model: ModelName) => models.installed(model);
            return {
              separation: yield* has("separation"),
              whisper: yield* has("whisper"),
              chart: (yield* Effect.forEach(CHART_MODELS, has)).every(Boolean),
            };
          }),
          signal,
        ),
      ),
      list: os.models.list.handler(({ signal }) => runRpc(runtime, modelFeatures, signal)),
      download: os.models.download.handler(({ input, signal }) =>
        withProgress(
          (onProgress, downloadSignal) => runRpc(runtime, downloadFeature(input.feature, onProgress), downloadSignal),
          signal,
        ),
      ),
      remove: os.models.remove.handler(({ input, signal }) => runRpc(runtime, removeFeature(input.feature), signal)),
    },
    tools: {
      status: os.tools.status.handler(({ signal }) =>
        runRpc(
          runtime,
          Tools.use((tools) => tools.status),
          signal,
        ),
      ),
      remove: os.tools.remove.handler(({ input, signal }) =>
        runRpc(
          runtime,
          Tools.use((tools) => Effect.andThen(tools.remove(input.tool), tools.status)),
          signal,
        ),
      ),
      prepare: os.tools.prepare.handler(({ input, signal }) =>
        withProgress(
          (onProgress, prepareSignal) =>
            runRpc(
              runtime,
              Effect.gen(function* () {
                const tools = yield* Tools;
                yield* tools.ensure(input.tools, { force: input.force ?? false, onProgress });
                return yield* tools.status;
              }),
              prepareSignal,
            ),
          signal,
        ),
      ),
    },
  };
}
