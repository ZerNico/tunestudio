/**
 * A project's song, vocals, music and video: replaced by a file the user has (copied in as it is, never encoded
 * again), the video removed, or the vocals and music separated from the song again. The vocals and music are always
 * there (the chart and its pitch follow them). Not part of undo.
 */
import { Effect, FileSystem, Path } from "effect";

import type { SongMediaRole } from "../../src/lib/native/contract";
import type { Progress } from "../../src/lib/native/types";
import { checkLength, ffmpegTools, probe } from "../audio-file/audio-file";
import { mapFileError, MissingMainAudio, SeparationFailed } from "../errors";
import { separateStems } from "../separation/separation";
import { AppSettings } from "../services/settings";
import {
  inTransaction,
  listMedia,
  mediaBaseName,
  putRole,
  replaceRole,
  withMediaLock,
  writeMediaToFile,
} from "./media";
import type { ProjectSession } from "./projects";

/** How an export names each one after the song ("Artist - Title [VOC].m4a"). */
const SUFFIX: Record<SongMediaRole, string> = { audio: "", vocals: " [VOC]", instrumental: " [INSTR]", video: "" };

/** Makes `file` the project's song, vocals, music or video, once FFprobe says it is one (and not too long). */
export function replaceSongMedia(session: ProjectSession, role: SongMediaRole, file: string) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const name = path.basename(file);
    const { ffprobe } = yield* ffmpegTools;
    const info = yield* probe(ffprobe, file, name, role === "video" ? "video" : "audio");
    if (role !== "video") yield* checkLength(info, name);
    const base = yield* mediaBaseName(session.db);
    yield* replaceRole(session.db, role, {
      path: file,
      fileName: `${base}${SUFFIX[role]}${path.extname(file).toLowerCase()}`,
      source: "chosen",
    });
  });
}

/** Removes the project's video (the song, vocals and music can only be replaced). */
export function removeVideo(session: ProjectSession) {
  return replaceRole(session.db, "video", null);
}

/**
 * Separates the vocals and music from the project's song again (as a new project does) and puts them in place of the
 * ones it has, encoded as the settings say.
 */
export function separateSong(
  session: ProjectSession,
  onProgress: (progress: Progress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const audio = (yield* listMedia(session.db)).find((row) => row.role === "audio");
    if (!audio) return yield* new MissingMainAudio({ message: "The project has no song to separate the voice from." });
    const settings = yield* AppSettings.use((stored) => stored.get);
    const { ffmpeg, ffprobe } = yield* ffmpegTools;
    const folder = yield* fs
      .makeTempDirectoryScoped({ prefix: "tunestudio-separate-" })
      .pipe(mapFileError("a temporary folder", "create"));
    const song = path.join(folder, `song${path.extname(audio.fileName).toLowerCase() || ".audio"}`);
    yield* writeMediaToFile(session.db, audio, song);
    const stems = yield* separateStems(
      { ffmpeg, ffprobe, audio: song, folder, format: settings.audio.format, bitrate: settings.audio.bitrate },
      onProgress,
    );
    const base = yield* mediaBaseName(session.db);
    // Both or neither, and only if the song is still the one they came from.
    yield* withMediaLock(
      session.db,
      Effect.gen(function* () {
        const now = (yield* listMedia(session.db)).find((row) => row.role === "audio");
        if (now?.id !== audio.id) {
          return yield* new SeparationFailed({
            message: "The song was replaced while the voice was separated. Separate it again.",
          });
        }
        // One transaction: a failure or a crash between the two leaves the old pair, never one of each.
        yield* inTransaction(
          session.db,
          Effect.forEach(
            ["vocals", "instrumental"] as const,
            (role) =>
              putRole(session.db, role, {
                path: stems[role],
                fileName: `${base}${SUFFIX[role]}${path.extname(stems[role]).toLowerCase()}`,
                source: "generated",
              }),
            { discard: true },
          ),
        );
      }).pipe(Effect.uninterruptible),
    );
  }).pipe(Effect.scoped);
}
