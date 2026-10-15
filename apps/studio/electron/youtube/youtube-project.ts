import { Effect, FileSystem, Path } from "effect";

import { songFileName } from "../../src/lib/file-names";
import type { CoverChoice, ProjectLyrics } from "../../src/lib/native/contract";
import type { DownloadedDraft, ImportProgress } from "../../src/lib/native/types";
import { DraftGone, mapFileError, VideoDownloadFailed } from "../errors";
import { listenToVocals } from "../listening/listening";
import { writeChart } from "../project/chart";
import { orDiskFull, writeMeta } from "../project/database";
import { imageExtension, readImage } from "../project/images";
import { writeLyrics } from "../project/lyrics";
import { type MediaRole, type MediaSource, writeMedia } from "../project/media";
import { Projects } from "../project/projects";
import { separateStems } from "../separation/separation";
import { Drafts } from "../services/drafts";
import { AppSettings } from "../services/settings";
import { COVER_HOSTS, Downloads, hostAllowed } from "../tools/downloads";
import { Tools } from "../tools/tools";
import { MOST_IMAGE_BYTES } from "./covers";
import { downloadVideo, watchUrl } from "./youtube";

/** A chart has to name a tempo; this one gives 50 ms beats until the chart is made. */
const DEFAULT_BPM = 300;

export interface YoutubeProjectInput {
  /** The draft `downloadIntoDraft` made. */
  draftId: string;
  artist: string;
  title: string;
  year: number | null;
  genre: string | null;
  /** A cover `findCovers` found, an image file (already allowed), the video's thumbnail, or none. */
  cover: CoverChoice;
  /** The lyrics the user accepted or wrote, or null for none. */
  lyrics: ProjectLyrics | null;
  /** The `.tunestudio` file to write. */
  target: string;
}

/**
 * Downloads a YouTube video as the settings say into a new draft and separates the vocals: the
 * first step of a new project, before the user has decided on lyrics or where to save. A failed
 * or cancelled download leaves no draft behind.
 */
export function downloadIntoDraft(
  videoId: string,
  onProgress: (progress: ImportProgress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const drafts = yield* Drafts;
    const settings = yield* AppSettings.use((stored) => stored.get);
    const draft = yield* drafts.create(videoId);
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

/** What Whisper hears in a draft's separated vocals. */
export function listenToDraft(
  draftId: string,
  heard: { language: string | null; mixed: boolean },
  onProgress: (progress: ImportProgress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const draft = yield* Drafts.use((drafts) => drafts.get(draftId));
    const vocals = draft.media?.vocals;
    if (!vocals) return yield* new DraftGone({ message: "The song isn't downloaded yet." });
    const { ffmpeg } = (yield* Tools.use((tools) => tools.ensure(["ffmpeg"]))).ffmpeg;
    if (!ffmpeg) return yield* new VideoDownloadFailed({ message: "The download tools are incomplete. Try again." });
    return yield* listenToVocals({ ffmpeg, vocals, folder: draft.folder, ...heard }, onProgress);
  });
}

/**
 * Writes a downloaded draft into a new project at `input.target`: the song details, an empty
 * chart, the lyrics, and the audio, video and cover. The draft is removed once the project is
 * saved; if saving fails, it stays so the user can try again.
 */
export function createYoutubeProject(
  input: YoutubeProjectInput,
  onProgress: (progress: ImportProgress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projects = yield* Projects;
      const drafts = yield* Drafts;
      const draft = yield* drafts.get(input.draftId);
      const media = draft.media;
      if (!media) return yield* new DraftGone({ message: "The song isn't downloaded yet." });
      const folder = draft.folder;

      const name = songFileName(input.artist, input.title);
      const files: { path: string; role: MediaRole; fileName: string; source: MediaSource }[] = [
        { path: media.audio, role: "audio", fileName: `${name}${path.extname(media.audio)}`, source: "youtube" },
      ];
      if (media.vocals) {
        files.push({
          path: media.vocals,
          role: "vocals",
          fileName: `${name} [VOC]${path.extname(media.vocals)}`,
          source: "generated",
        });
      }
      if (media.instrumental) {
        files.push({
          path: media.instrumental,
          role: "instrumental",
          fileName: `${name} [INSTR]${path.extname(media.instrumental)}`,
          source: "generated",
        });
      }
      if (media.video) {
        files.push({
          path: media.video,
          role: "video",
          fileName: `${name}${path.extname(media.video)}`,
          source: "youtube",
        });
      }
      const warnings = media.videoProblem
        ? [`The video couldn't be downloaded, so the project only has the audio. ${media.videoProblem}`]
        : [];
      let cover: string | null = null;
      if (input.cover.kind === "thumbnail") cover = media.cover;
      if (input.cover.kind === "file") {
        const image = yield* readImage(input.cover.path);
        cover = path.join(folder, `chosen-cover${image.extension}`);
        yield* fs.writeFile(cover, image.bytes).pipe(mapFileError("the cover", "save"));
      }
      if (input.cover.kind === "found") {
        yield* onProgress({ step: "Downloading the cover", done: 0, total: 0 });
        cover = yield* downloadCover(input.cover.url, folder);
        if (!cover) {
          cover = media.cover;
          warnings.push("The chosen cover couldn't be downloaded, so the video's thumbnail is the cover.");
        }
      }
      if (cover) {
        files.push({ path: cover, role: "cover", fileName: `${name} [CO]${path.extname(cover)}`, source: "youtube" });
      }

      const session = yield* projects.create(input.target, (db) =>
        Effect.gen(function* () {
          yield* onProgress({ step: "Saving the project", done: 0, total: 0 });
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* writeChart(tx, {
                  song: {
                    title: input.title.trim() || "Untitled",
                    artist: input.artist.trim() || "Unknown artist",
                    language: [],
                    year: input.year,
                    genre: input.genre?.trim() || null,
                    edition: null,
                    creator: null,
                    bpm: DEFAULT_BPM,
                    gap: 0,
                    videoGap: null,
                    start: null,
                    end: null,
                    previewStart: null,
                    medleyStart: null,
                    medleyEnd: null,
                    extraHeaders: [],
                  },
                  singers: [{ index: 1, name: null, lines: [] }],
                });
                yield* writeMeta(tx, {
                  imported_from: watchUrl(draft.videoId),
                  import_warnings: JSON.stringify(warnings),
                });
              }),
            )
            .pipe(orDiskFull);
          for (const file of files) {
            const size = Number((yield* fs.stat(file.path).pipe(Effect.orDie)).size);
            const row = yield* writeMedia(db, file, (written) =>
              onProgress({ step: `Saving ${file.fileName}`, done: written, total: size }),
            ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
            if (file.role === "audio" && input.lyrics && input.lyrics.lines.length > 0) {
              yield* writeLyrics(db, row, input.lyrics).pipe(orDiskFull);
            }
          }
        }),
      );
      yield* drafts.discard(draft.id);
      return session;
    }),
  );
}

/** Downloads a chosen cover into `folder`, named for what it is (JPEG or PNG), or null if that fails. */
function downloadCover(url: string, folder: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const downloads = yield* Downloads;
    // The URL comes from the renderer: only the cover catalogs, not every host downloads may use.
    if (!URL.canParse(url) || !hostAllowed(new URL(url).hostname, COVER_HOSTS)) return null;
    const file = path.join(folder, "chosen-cover");
    yield* downloads.file(url, file, () => Effect.void, { hosts: COVER_HOSTS, maxBytes: MOST_IMAGE_BYTES });
    const bytes = yield* fs.readFile(file);
    const extension = imageExtension(bytes);
    if (!extension) return null;
    yield* fs.rename(file, `${file}${extension}`);
    return `${file}${extension}`;
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() => null),
  );
}
