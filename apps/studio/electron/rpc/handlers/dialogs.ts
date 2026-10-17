/** The open and save dialogs, on the calling window. What the user picks may be read afterwards (`grant`). */
import { Effect, FileSystem, Path } from "effect";

import { safeFileName } from "../../../src/lib/file-names";
import type { ChosenImage } from "../../../src/lib/native/types";
import { ImageUnreadable } from "../../errors";
import { readImage } from "../../project/images";
import { Desktop } from "../../services/desktop";
import { grant, type GroupHandlers, windowOf } from "./shared";

/** The default folder for new projects, under the user's Music folder. */
const PROJECTS_FOLDER = "Tune Studio";

export const dialogHandlers = {
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
      return yield* grant(chosen);
    }),
  "dialogs.chooseMediaFile": (input, { client }) =>
    Effect.gen(function* () {
      const desktop = yield* Desktop;
      return yield* grant(yield* desktop.chooseMediaFile(yield* windowOf(client), input.kind));
    }),
  "dialogs.chooseUsdbFile": (input, { client }) =>
    Effect.gen(function* () {
      const desktop = yield* Desktop;
      const paths = yield* Path.Path;
      const chosen = yield* desktop.chooseTextFile(
        yield* windowOf(client),
        paths.join(desktop.musicFolder, `${safeFileName(input.name)}.txt`),
      );
      return yield* grant(chosen);
    }),
  "dialogs.chooseExportFolder": (_, { client }) =>
    Effect.gen(function* () {
      const desktop = yield* Desktop;
      return yield* grant(yield* desktop.chooseExportFolder(yield* windowOf(client), desktop.musicFolder));
    }),
} satisfies GroupHandlers<"dialogs">;
