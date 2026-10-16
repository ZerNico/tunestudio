import { randomUUID } from "node:crypto";

import { Context, Effect, FileSystem, Layer, Path, Ref } from "effect";

import { DraftGone, type FileError, mapFileError } from "../errors";
import type { ProjectChart } from "../ultrastar/chart-mapping";
import type { DownloadedMedia } from "../youtube/youtube";

/** Where a new project's song comes from: a YouTube video, or an audio file the user has. */
export type DraftSource = { kind: "youtube"; videoId: string } | { kind: "file"; path: string };

/** A chart made for a draft, and what it was made from (`chartInputsKey`), so a changed choice can be noticed. */
export interface DraftChart {
  /** Its song details are placeholders: the project gets the ones chosen when it is created. */
  readonly chart: ProjectChart;
  readonly madeFrom: string;
  /** The sung pitch it followed (MIDI per 10 ms, NaN where nothing is sung), stored with the vocals. */
  readonly pitch: Float32Array;
}

/** A new project being set up: its working folder, what is in it so far, and the chart if one was made. */
export interface Draft {
  readonly id: string;
  readonly folder: string;
  readonly source: DraftSource;
  readonly media: DownloadedMedia | null;
  readonly chart: DraftChart | null;
}

interface DraftsShape {
  /** A new, empty draft. */
  readonly create: (source: DraftSource) => Effect.Effect<Draft, FileError>;
  readonly get: (id: string) => Effect.Effect<Draft, DraftGone>;
  /** Records what was downloaded into a draft. */
  readonly setMedia: (id: string, media: DownloadedMedia) => Effect.Effect<void, DraftGone>;
  /** Records the chart made for a draft (null forgets it). */
  readonly setChart: (id: string, chart: DraftChart | null) => Effect.Effect<void, DraftGone>;
  /** Removes a draft and its files. Discarding one that is gone does nothing. */
  readonly discard: (id: string) => Effect.Effect<void>;
}

/**
 * New projects while they are set up, before the user saves them: downloads land in a draft
 * folder, and the project file is only written at the end. Cancelling discards the draft.
 */
export class Drafts extends Context.Service<Drafts, DraftsShape>()("studio/Drafts") {}

/**
 * Drafts in `folder` (in the app's data directory). Whatever is there when the app starts was
 * left by a crash, since only one Tune Studio runs at a time, so it is removed; so is every
 * draft when the app quits.
 */
export function draftsLayer(folder: string) {
  return Layer.effect(
    Drafts,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const clear = fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore);
      yield* clear;
      yield* Effect.addFinalizer(() => clear);
      const drafts = yield* Ref.make(new Map<string, Draft>());

      const get = (id: string) =>
        Effect.flatMap(Ref.get(drafts), (all) => {
          const draft = all.get(id);
          return draft
            ? Effect.succeed(draft)
            : Effect.fail(new DraftGone({ message: "This new project was closed. Start it again." }));
        });

      return {
        create: (source) =>
          Effect.gen(function* () {
            const id = randomUUID();
            const draft: Draft = { id, folder: paths.join(folder, id), source, media: null, chart: null };
            yield* fs
              .makeDirectory(draft.folder, { recursive: true })
              .pipe(mapFileError("the new project's folder", "create"));
            yield* Ref.update(drafts, (all) => new Map(all).set(id, draft));
            return draft;
          }),
        get,
        setMedia: (id, media) =>
          Effect.flatMap(get(id), (draft) => Ref.update(drafts, (all) => new Map(all).set(id, { ...draft, media }))),
        setChart: (id, chart) =>
          Effect.flatMap(get(id), (draft) => Ref.update(drafts, (all) => new Map(all).set(id, { ...draft, chart }))),
        discard: (id) =>
          Effect.gen(function* () {
            const draft = (yield* Ref.get(drafts)).get(id);
            if (!draft) return;
            yield* Ref.update(drafts, (all) => {
              const next = new Map(all);
              next.delete(id);
              return next;
            });
            yield* fs.remove(draft.folder, { recursive: true, force: true }).pipe(Effect.ignore);
          }),
      } satisfies DraftsShape;
    }),
  );
}
