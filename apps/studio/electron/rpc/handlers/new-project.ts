/** New projects from YouTube or an audio file, and the drafts every new project is made in. */
import { Effect } from "effect";

import { audioFileIntoDraft, inspectAudioFile } from "../../audio-file/audio-file";
import { createDraftProject, listenToDraft, makeDraftChart } from "../../drafts/draft-project";
import { Drafts } from "../../services/drafts";
import { findCovers } from "../../youtube/covers";
import { findLyrics } from "../../youtube/lyrics";
import { inspectVideo } from "../../youtube/youtube";
import { downloadIntoDraft } from "../../youtube/youtube-draft";
import { allowedPath, discardUndelivered, type GroupHandlers, notShown, openedIn, progressStream } from "./shared";

export const youtubeHandlers = {
  "youtube.inspect": (input) => inspectVideo(input.videoId),
  "youtube.findCovers": (input) => findCovers(input),
  "youtube.findLyrics": (input) => findLyrics(input),
  "youtube.download": (input) =>
    progressStream((onProgress) => downloadIntoDraft(input.videoId, onProgress), discardUndelivered),
} satisfies GroupHandlers<"youtube">;

export const audioHandlers = {
  "audio.inspect": (input) => Effect.flatMap(allowedPath(input.path), inspectAudioFile),
  "audio.import": (input) =>
    progressStream(
      (onProgress) => Effect.flatMap(allowedPath(input.path), (path) => audioFileIntoDraft(path, onProgress)),
      discardUndelivered,
    ),
} satisfies GroupHandlers<"audio">;

export const draftHandlers = {
  "drafts.listen": (input) =>
    progressStream((onProgress) =>
      listenToDraft(input.draftId, { language: input.language, mixed: input.mixed }, onProgress),
    ),
  "drafts.makeChart": (input) => progressStream((onProgress) => makeDraftChart(input, onProgress)),
  "drafts.create": (input, { client }) =>
    progressStream((onProgress) =>
      Effect.gen(function* () {
        const target = yield* allowedPath(input.target);
        yield* notShown(target);
        const cover =
          input.cover.kind === "file"
            ? { kind: "file" as const, path: yield* allowedPath(input.cover.path) }
            : input.cover;
        const session = yield* createDraftProject({ ...input, cover, target }, onProgress);
        return yield* openedIn(client, session);
      }),
    ),
  "drafts.discard": (input) => Drafts.use((drafts) => drafts.discard(input.draftId)),
} satisfies GroupHandlers<"drafts">;
