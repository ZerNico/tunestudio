import { Effect, FileSystem } from "effect";

import type { DownloadedDraft, Progress } from "../../src/lib/native/types";
import { VideoDownloadFailed } from "../errors";
import { separateStems } from "../separation/separation";
import { Drafts } from "../services/drafts";
import { AppSettings } from "../services/settings";
import { Tools } from "../tools/tools";
import { downloadVideo } from "./youtube";

/**
 * Downloads a YouTube video as the settings say into a new draft and separates the vocals: the
 * first step of a new project, before the user has decided on lyrics or where to save. A failed
 * or cancelled download leaves no draft behind.
 */
export function downloadIntoDraft(
  videoId: string,
  onProgress: (progress: Progress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const drafts = yield* Drafts;
    const settings = yield* AppSettings.use((stored) => stored.get);
    const draft = yield* drafts.create({ kind: "youtube", videoId });
    const size = (file: string) => Effect.map(fs.stat(file), (info) => Number(info.size));
    return yield* Effect.gen(function* () {
      const downloaded = yield* downloadVideo(videoId, settings, draft.folder, onProgress);
      const { ffmpeg, ffprobe } = (yield* Tools.use((tools) => tools.ensure(["ffmpeg"]))).ffmpeg;
      if (!ffmpeg || !ffprobe) {
        return yield* new VideoDownloadFailed({ message: "The download tools are incomplete. Try again." });
      }
      const stems = yield* separateStems(
        {
          ffmpeg,
          ffprobe,
          audio: downloaded.audio,
          folder: draft.folder,
          format: settings.audio.format,
          bitrate: settings.audio.bitrate,
        },
        onProgress,
      );
      const media = { ...downloaded, ...stems };
      yield* drafts.setMedia(draft.id, media);
      return {
        draftId: draft.id,
        audio: { size: yield* size(media.audio).pipe(Effect.orElseSucceed(() => 0)) },
        video: media.video ? { size: yield* size(media.video).pipe(Effect.orElseSucceed(() => 0)) } : null,
        videoProblem: media.videoProblem,
      } satisfies DownloadedDraft;
    }).pipe(Effect.onError(() => drafts.discard(draft.id)));
  });
}
