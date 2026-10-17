/** New projects from an UltraStar song folder (or chart): inspecting it, separating its voice, importing it. */
import { Effect } from "effect";

import { Drafts } from "../../services/drafts";
import { describeSong, importSong, inspectSong, separateSongFolder } from "../../ultrastar/song-import";
import { allowedPath, discardUndelivered, type GroupHandlers, notShown, openedIn, progressStream } from "./shared";

export const songHandlers = {
  "song.inspect": (input) =>
    Effect.flatMap(allowedPath(input.path), (path) => Effect.map(inspectSong(path, input.chart), describeSong)),
  "song.separate": (input) =>
    progressStream(
      (onProgress) =>
        Effect.gen(function* () {
          const path = yield* allowedPath(input.path);
          const source = yield* inspectSong(path, input.chart);
          return { draftId: yield* separateSongFolder(source, onProgress) };
        }),
      discardUndelivered,
    ),
  "song.import": (input, { client }) =>
    progressStream((onProgress) =>
      Effect.gen(function* () {
        const path = yield* allowedPath(input.path);
        const target = yield* allowedPath(input.target);
        yield* notShown(target);
        const source = yield* inspectSong(path, input.chart);
        const media = input.draftId ? (yield* Drafts.use((drafts) => drafts.get(input.draftId!))).media : null;
        const stems =
          media?.vocals && media.instrumental ? { vocals: media.vocals, instrumental: media.instrumental } : undefined;
        const session = yield* importSong(source, { includeVideo: input.includeVideo, target, stems }, onProgress);
        if (input.draftId) yield* Drafts.use((drafts) => drafts.discard(input.draftId!));
        return yield* openedIn(client, session);
      }),
    ),
} satisfies GroupHandlers<"song">;
