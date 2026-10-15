/**
 * The handlers of the calls in `NativeRpcs` (`src/lib/native/contract.ts`), on the main process services. Every path
 * from the renderer goes through `allowedPath` first.
 */
import { Context, Effect, Exit, FileSystem, Path, Queue, Stream } from "effect";
import type { BrowserWindow } from "electron";

import { safeFileName } from "../../src/lib/file-names";
import { NativeRpcs } from "../../src/lib/native/contract";
import type { ChosenImage, OpenedProject, RecentProjectEntry } from "../../src/lib/native/types";
import { generateChart } from "../charting/generate";
import { createDraftProject, listenToDraft, makeDraftChart } from "../drafts/draft-project";
import { ImageUnreadable } from "../errors";
import { downloadFeature, modelFeatures, removeFeature } from "../models/features";
import { CHART_MODELS, type ModelName, Models } from "../models/models";
import { applyChartChanges } from "../project/chart-changes";
import { readEditorChart } from "../project/editor-chart";
import { readImage } from "../project/images";
import { projectOverview, recentEntry } from "../project/overview";
import { sungPitch } from "../project/pitch";
import { Projects, type ProjectSession } from "../project/projects";
import { AppLog } from "../services/app-log";
import { Desktop } from "../services/desktop";
import { Drafts } from "../services/drafts";
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

/** The default folder for new projects, under the user's Music folder. */
export const PROJECTS_FOLDER = "Tune Studio";

/** The windows calls come from, by their connection's client id (`port-protocol.ts`), for dialogs to belong to. */
export class Callers extends Context.Service<
  Callers,
  { readonly windowOf: (clientId: number) => BrowserWindow | null }
>()("studio/RpcCallers") {}

const windowOf = (client: { readonly id: number }) => Callers.useSync((callers) => callers.windowOf(client.id));

/** `path`, if the user picked or dropped it in this session (or it is a listed recent project). */
export const allowedPath = (path: string) =>
  Effect.gen(function* () {
    const grants = yield* PathGrants;
    if (!(yield* grants.allows(path))) return yield* notAllowed();
    return normalizePath(path);
  });

const project = (id: string) => Projects.use((projects) => projects.get(id));

const grant = (path: string | null) =>
  path === null
    ? Effect.succeed(null)
    : Effect.as(
        PathGrants.use((grants) => grants.grant(path)),
        path,
      );

/** Puts an opened project at the top of the recents; failing to save the list doesn't stop the open. */
export const remember = (session: ProjectSession) =>
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

/** A call's progress events, then its result (the shape `progress` in contract.ts describes). */
type ProgressEvent<P, A> =
  | { readonly _tag: "Progress"; readonly progress: P }
  | { readonly _tag: "Done"; readonly result: A };

/**
 * Long work (an import, downloads) as a stream of its progress events and then its result. Stopping the stream (the
 * renderer cancelled) interrupts the work, which cleans up after itself. Work that finished anyway, with a result the
 * renderer never got, is handed to `onUndelivered`.
 */
export function progressStream<P, A, E, R, R2 = never>(
  run: (onProgress: (progress: P) => Effect.Effect<void>) => Effect.Effect<A, E, R>,
  onUndelivered?: (result: A) => Effect.Effect<void, never, R2>,
): Stream.Stream<ProgressEvent<P, A>, E, R | R2> {
  let finished: { result: A } | undefined;
  return Stream.callback<ProgressEvent<P, A>, E, R>((queue) =>
    run((progress) => Effect.asVoid(Queue.offer(queue, { _tag: "Progress", progress }))).pipe(
      Effect.flatMap((result) => {
        finished = { result };
        return Queue.offer(queue, { _tag: "Done", result });
      }),
      Effect.andThen(Queue.end(queue)),
    ),
  ).pipe(
    // The renderer doesn't stop a stream once it has the result, so only a stream stopped before then lost it.
    Stream.onExit((exit): Effect.Effect<void, never, R2> =>
      Exit.isFailure(exit) && finished && onUndelivered ? onUndelivered(finished.result) : Effect.void,
    ),
  );
}

export const nativeHandlers = NativeRpcs.toLayer({
  "app.log": (input) => AppLog.use((log) => log.write(input.level.toUpperCase(), "renderer", input.message)),

  "dialogs.chooseSong": (_, { client }) =>
    Effect.gen(function* () {
      const window = yield* windowOf(client);
      return yield* grant(yield* Desktop.use((desktop) => desktop.chooseSong(window)));
    }),
  "dialogs.chooseProject": (_, { client }) =>
    Effect.gen(function* () {
      const window = yield* windowOf(client);
      return yield* grant(yield* Desktop.use((desktop) => desktop.chooseProject(window)));
    }),
  "dialogs.chooseCoverImage": (_, { client }) =>
    Effect.gen(function* () {
      const desktop = yield* Desktop;
      const path = yield* grant(yield* desktop.chooseImage(yield* windowOf(client)));
      if (path === null) return null;
      const { bytes } = yield* readImage(path);
      const preview = yield* desktop.thumbnail(bytes);
      if (!preview) return yield* new ImageUnreadable({ message: "This image couldn't be read." });
      return { path, preview } satisfies ChosenImage;
    }),
  "dialogs.chooseProjectLocation": (input, { client }) =>
    Effect.gen(function* () {
      const desktop = yield* Desktop;
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const folder = paths.join(desktop.musicFolder, PROJECTS_FOLDER);
      // The suggested folder has to exist for the dialog to start in it.
      yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.ignore);
      const chosen = yield* desktop.chooseProjectLocation(
        yield* windowOf(client),
        paths.join(folder, `${safeFileName(input.name)}.tunestudio`),
      );
      if (!chosen) return null;
      return yield* grant(chosen.toLowerCase().endsWith(".tunestudio") ? chosen : `${chosen}.tunestudio`);
    }),
  "dialogs.chooseExportFolder": (_, { client }) =>
    Effect.gen(function* () {
      const desktop = yield* Desktop;
      return yield* grant(yield* desktop.chooseExportFolder(yield* windowOf(client), desktop.musicFolder));
    }),

  "song.inspect": (input) =>
    Effect.flatMap(allowedPath(input.path), (path) => Effect.map(inspectSong(path, input.chart), describeSong)),
  "song.import": (input) =>
    progressStream((onProgress) =>
      Effect.gen(function* () {
        const path = yield* allowedPath(input.path);
        const target = yield* allowedPath(input.target);
        const source = yield* inspectSong(path, input.chart);
        const session = yield* importSong(source, { includeVideo: input.includeVideo, target }, onProgress);
        return yield* remember(session);
      }),
    ),

  "project.open": (input) =>
    Effect.gen(function* () {
      const path = yield* allowedPath(input.path);
      const session = yield* Projects.use((projects) => projects.open(path));
      return yield* remember(session);
    }),
  "project.overview": (input) => Effect.flatMap(project(input.id), projectOverview),
  "project.close": (input) => Projects.use((projects) => projects.close(input.id)),
  "project.pitch": (input) =>
    progressStream((onProgress) => Effect.flatMap(project(input.id), (session) => sungPitch(session, onProgress))),
  "project.applyChanges": (input) =>
    Effect.flatMap(project(input.id), (session) =>
      session.db.transaction((tx) => applyChartChanges(tx, input.changes)),
    ),
  "project.chart": (input) => Effect.flatMap(project(input.id), (session) => readEditorChart(session.db)),
  "project.exportSong": (input) =>
    Effect.gen(function* () {
      const folder = yield* allowedPath(input.folder);
      const session = yield* project(input.id);
      const result = yield* exportSong(session, folder, input.replace);
      yield* grant(result.folder);
      return result;
    }),
  "project.makeChart": (input) =>
    progressStream((onProgress) =>
      Effect.gen(function* () {
        const session = yield* project(input.id);
        yield* generateChart(session, onProgress);
        return yield* projectOverview(session);
      }),
    ),

  "recents.list": () =>
    Effect.gen(function* () {
      const projects = yield* Recents.use((recents) => recents.list);
      // The listed projects may be opened, revealed or restored after removing them.
      yield* Effect.forEach(projects, (entry) => grant(entry.path), { discard: true });
      return projects;
    }),
  "recents.remove": (input) => Recents.use((recents) => recents.remove(normalizePath(input.path))),
  "recents.restore": (input) =>
    Effect.flatMap(allowedPath(input.path), (path) =>
      Recents.use((recents) => recents.restore({ ...input, path } satisfies RecentProjectEntry)),
    ),

  "files.reveal": (input) =>
    Effect.flatMap(allowedPath(input.path), (path) => Desktop.use((desktop) => desktop.reveal(path))),

  "youtube.inspect": (input) => inspectVideo(input.videoId),
  "youtube.findCovers": (input) => findCovers(input),
  "youtube.findLyrics": (input) => findLyrics(input),
  "youtube.download": (input) =>
    progressStream(
      (onProgress) => downloadIntoDraft(input.videoId, onProgress),
      // Cancelled just as it finished: the renderer won't hear of this draft to discard it.
      (draft) => Drafts.use((drafts) => drafts.discard(draft.draftId)).pipe(Effect.ignore),
    ),

  "drafts.listen": (input) =>
    progressStream((onProgress) =>
      listenToDraft(input.draftId, { language: input.language, mixed: input.mixed }, onProgress),
    ),
  "drafts.makeChart": (input) => progressStream((onProgress) => makeDraftChart(input, onProgress)),
  "drafts.create": (input) =>
    progressStream((onProgress) =>
      Effect.gen(function* () {
        const target = yield* allowedPath(input.target);
        const cover =
          input.cover.kind === "file"
            ? { kind: "file" as const, path: yield* allowedPath(input.cover.path) }
            : input.cover;
        const session = yield* createDraftProject({ ...input, cover, target }, onProgress);
        return yield* remember(session);
      }),
    ),
  "drafts.discard": (input) => Drafts.use((drafts) => drafts.discard(input.draftId)),

  "settings.get": () => AppSettings.use((settings) => settings.get),
  "settings.set": (input) => AppSettings.use((settings) => settings.set(input)),

  "models.status": () =>
    Effect.gen(function* () {
      const models = yield* Models;
      const has = (model: ModelName) => models.installed(model);
      return {
        separation: yield* has("separation"),
        whisper: yield* has("whisper"),
        chart: (yield* Effect.forEach(CHART_MODELS, has)).every(Boolean),
      };
    }),
  "models.list": () => modelFeatures,
  "models.download": (input) => progressStream((onProgress) => downloadFeature(input.feature, onProgress)),
  "models.remove": (input) => removeFeature(input.feature),

  "tools.status": () => Tools.use((tools) => tools.status),
  "tools.remove": (input) => Tools.use((tools) => Effect.andThen(tools.remove(input.tool), tools.status)),
  "tools.prepare": (input) =>
    progressStream((onProgress) =>
      Effect.gen(function* () {
        const tools = yield* Tools;
        yield* tools.ensure(input.tools, { force: input.force ?? false, onProgress });
        return yield* tools.status;
      }),
    ),
});
