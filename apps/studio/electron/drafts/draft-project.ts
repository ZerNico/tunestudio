/**
 * A new project's draft after its song is in it, whatever it came from: listening to the vocals, making the chart, and
 * saving it all as a project. Getting the song into a draft is the source's part (`youtube/youtube-draft.ts`).
 */
import { Effect, FileSystem, Path } from "effect";

import { chartInputsKey } from "../../src/lib/chart-inputs";
import { songFileName } from "../../src/lib/file-names";
import { languageName } from "../../src/lib/languages";
import type { DraftProjectInput } from "../../src/lib/native/contract";
import type { ImportProgress, MadeChart } from "../../src/lib/native/types";
import { chartFromFiles, chartLanguage } from "../charting/generate";
import type { ChartSongDetails } from "../charting/project-chart";
import { ChartFailed, ChartOutdated, DraftGone, mapFileError, VideoDownloadFailed } from "../errors";
import { listenToVocals } from "../listening/listening";
import { writeChart } from "../project/chart";
import { orDiskFull, writeMeta } from "../project/database";
import { imageExtension, readImage } from "../project/images";
import { writeLyrics } from "../project/lyrics";
import { type MediaRole, type MediaSource, writeMedia } from "../project/media";
import { Projects } from "../project/projects";
import { type Draft, type DraftSource, Drafts } from "../services/drafts";
import { AppSettings } from "../services/settings";
import { COVER_HOSTS, Downloads, hostAllowed } from "../tools/downloads";
import { Tools } from "../tools/tools";
import { MOST_IMAGE_BYTES } from "../youtube/covers";
import { watchUrl } from "../youtube/youtube";

/** A chart has to name a tempo; this one gives 50 ms beats until the chart is made. */
const DEFAULT_BPM = 300;

/** Song details for a chart that is made before they are chosen; the project gets the chosen ones. */
const PLACEHOLDER_DETAILS: ChartSongDetails = {
  title: "",
  artist: "",
  language: [],
  year: null,
  genre: null,
  edition: null,
  creator: null,
};

/** What a project records about where its song came from. */
function sourceDetails(source: DraftSource): { media: MediaSource; importedFrom: string } {
  return { media: "youtube", importedFrom: watchUrl(source.videoId) };
}

/** A draft whose song is in it. */
function downloadedDraft(draftId: string) {
  return Effect.gen(function* () {
    const draft = yield* Drafts.use((drafts) => drafts.get(draftId));
    if (!draft.media) return yield* new DraftGone({ message: "The song isn't downloaded yet." });
    return { ...draft, media: draft.media } satisfies Draft;
  });
}

/** What Whisper hears in a draft's separated vocals. */
export function listenToDraft(
  draftId: string,
  heard: { language: string | null; mixed: boolean },
  onProgress: (progress: ImportProgress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const draft = yield* downloadedDraft(draftId);
    const vocals = draft.media.vocals;
    if (!vocals) return yield* new DraftGone({ message: "The voice wasn't separated from the song." });
    const { ffmpeg } = (yield* Tools.use((tools) => tools.ensure(["ffmpeg"]))).ffmpeg;
    if (!ffmpeg) return yield* new VideoDownloadFailed({ message: "The download tools are incomplete. Try again." });
    return yield* listenToVocals({ ffmpeg, vocals, folder: draft.folder, ...heard }, onProgress);
  });
}

/**
 * Makes the chart for a draft from its vocals and these lyrics, and keeps it in the draft until the project is
 * created. A chart made before is forgotten first, so a failed or cancelled one leaves none.
 */
export function makeDraftChart(
  input: { draftId: string; lines: readonly { start: number | null; text: string }[]; language: string },
  onProgress: (progress: ImportProgress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const drafts = yield* Drafts;
    const draft = yield* downloadedDraft(input.draftId);
    yield* drafts.setChart(draft.id, null);
    const language = chartLanguage([languageName(input.language)]);
    if (typeof language === "string") return yield* new ChartFailed({ message: language });
    if (!draft.media.vocals) {
      return yield* new ChartFailed({
        message: "The voice wasn't separated from the song, so there is nothing to chart.",
      });
    }
    const chart = yield* chartFromFiles(
      { vocalsFile: draft.media.vocals, audioFile: draft.media.audio, lines: input.lines, language },
      PLACEHOLDER_DETAILS,
      onProgress,
    );
    const madeFrom = chartInputsKey(input.lines, input.language);
    yield* drafts.setChart(draft.id, { chart, madeFrom });
    const lines = chart.singers.flatMap((singer) => singer.lines);
    return {
      notes: lines.reduce((count, line) => count + line.notes.length, 0),
      lines: lines.length,
      madeFrom,
    } satisfies MadeChart;
  });
}

/**
 * Writes a draft into a new project at `input.target`: the song details, the chart made for it (or an empty one), the
 * lyrics, and the audio, video and cover. The draft is removed once the project is saved; if saving fails, it stays
 * so the user can try again. The song's language is remembered for the next new project.
 */
export function createDraftProject(
  input: DraftProjectInput,
  onProgress: (progress: ImportProgress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projects = yield* Projects;
      const drafts = yield* Drafts;
      const draft = yield* downloadedDraft(input.draftId);
      const { media, folder } = draft;
      const source = sourceDetails(draft.source);

      let made = null;
      if (input.chart === "made") {
        if (!draft.chart) return yield* new ChartOutdated({ message: "The chart wasn't made. Make it again." });
        if (draft.chart.madeFrom !== chartInputsKey(input.lyrics?.lines, input.language)) {
          return yield* new ChartOutdated({
            message: "The lyrics or the language changed after the chart was made. Make it again.",
          });
        }
        made = draft.chart.chart;
      }

      const name = songFileName(input.artist, input.title);
      const files: { path: string; role: MediaRole; fileName: string; source: MediaSource }[] = [
        { path: media.audio, role: "audio", fileName: `${name}${path.extname(media.audio)}`, source: source.media },
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
          source: source.media,
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
        files.push({
          path: cover,
          role: "cover",
          fileName: `${name} [CO]${path.extname(cover)}`,
          source: source.media,
        });
      }

      const details = {
        title: input.title.trim() || "Untitled",
        artist: input.artist.trim() || "Unknown artist",
        language: input.language ? [languageName(input.language)] : [],
        year: input.year,
        genre: input.genre?.trim() || null,
        edition: null,
        creator: null,
      };
      const chart = made
        ? { ...made, song: { ...made.song, ...details } }
        : {
            song: {
              ...details,
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
          };

      const session = yield* projects.create(input.target, (db) =>
        Effect.gen(function* () {
          yield* onProgress({ step: "Saving the project", done: 0, total: 0 });
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* writeChart(tx, chart);
                yield* writeMeta(tx, {
                  imported_from: source.importedFrom,
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
      if (input.language) yield* rememberLanguage(input.language);
      return session;
    }),
  );
}

/** Offers `language` first for the next new project; not being able to save that doesn't matter. */
function rememberLanguage(language: string) {
  return AppSettings.use((stored) => stored.remember({ language })).pipe(Effect.ignore);
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
