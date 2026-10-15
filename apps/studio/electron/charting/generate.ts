/**
 * "Make the chart" for an open project: its vocals, song and lyrics through the chart pipeline (pipeline.ts), the
 * result written over the project's notes in one transaction. Downloads the chart models first if needed.
 */
import { Effect, FileSystem, Path } from "effect";

import { CHART_STEPS, GETTING_CHART_MODELS, READING_SONG } from "../../src/lib/chart-steps";
import type { ImportProgress } from "../../src/lib/native/types";
import { ChartFailed, mapFileError } from "../errors";
import { CHART_MODELS, Models } from "../models/models";
import { Native } from "../native/native";
import { readChart, replaceChart } from "../project/chart";
import { readLyrics } from "../project/lyrics";
import { listMedia, writeMediaToFile } from "../project/media";
import { sungMidi, writePitch } from "../project/pitch";
import type { ProjectSession } from "../project/projects";
import { AppLog } from "../services/app-log";
import { Tools } from "../tools/tools";
import { AlignFailed, type LyricLine } from "./align-stage";
import { decodeMono } from "./audio";
import { GAME_SAMPLE_RATE, makeChart, type ChartEngines, type ChartLanguage, type ChartStep } from "./pipeline";
import { PITCH_SAMPLE_RATE } from "./pitch-track";
import { toProjectChart, type ChartSongDetails } from "./project-chart";

export { GETTING_CHART_MODELS, READING_SONG };
const STEPS: Record<ChartStep, string> = CHART_STEPS;
const BEAT_SAMPLE_RATE = 22_050;

/** The languages charts can be made in so far, by the names projects store. */
const LANGUAGES: Record<string, ChartLanguage> = {
  english: { name: "english", code: "eng" },
  german: { name: "german", code: "deu" },
};

/** The chart language for a project's languages (its first one), or why there is none. */
export function chartLanguage(languages: readonly string[]): ChartLanguage | string {
  const first = languages[0];
  if (!first) return "Set the song's language first.";
  return LANGUAGES[first.trim().toLowerCase()] ?? `Charts can't be made in ${first} yet, only in English and German.`;
}

/** What a chart is made from: the vocal stem and the song as files, the lyrics and their language. */
export interface ChartSource {
  vocalsFile: string;
  audioFile: string;
  lines: readonly { start: number | null; text: string }[];
  language: ChartLanguage;
}

/**
 * A chart from files: the chart models (downloaded first if needed) over the decoded vocals and song, with the sung
 * pitch it followed. The chart's song details are `details` with its grid; nothing is written anywhere.
 */
export function chartFromFiles(
  source: ChartSource,
  details: ChartSongDetails,
  onProgress: (progress: ImportProgress) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const log = yield* AppLog;
    const { ffmpeg } = (yield* Tools.use((tools) => tools.ensure(["ffmpeg"]))).ffmpeg;
    if (!ffmpeg) return yield* new ChartFailed({ message: "FFmpeg couldn't be installed. Try again." });
    const models = yield* (yield* Models).ensureAll(CHART_MODELS, (received, total) =>
      onProgress({ step: GETTING_CHART_MODELS, done: received, total }),
    );
    const addon = yield* (yield* Native).addon;

    yield* onProgress({ step: READING_SONG, done: 0, total: 100, unit: "percent" });
    const folder = yield* fs
      .makeTempDirectoryScoped({ prefix: "tunestudio-chart-" })
      .pipe(mapFileError("a temporary folder", "create"));
    const vocals16k = yield* decodeMono(ffmpeg, source.vocalsFile, PITCH_SAMPLE_RATE, folder);
    const vocals44k = yield* decodeMono(ffmpeg, source.vocalsFile, GAME_SAMPLE_RATE, folder);
    const mix22k = yield* decodeMono(ffmpeg, source.audioFile, BEAT_SAMPLE_RATE, folder);

    const lines: LyricLine[] = source.lines
      .filter((line) => line.text.trim())
      .map((line) => ({ text: line.text, start: line.start, end: null }));
    if (!lines.length) return yield* new ChartFailed({ message: "The song has no lyrics yet. Add them first." });
    const started = Date.now();
    const result = yield* Effect.tryPromise({
      try: (signal) => {
        const engines: ChartEngines = {
          trackPitch: (samples) => addon.trackPitch(models.chartPitch, samples),
          beatLogits: (samples) => addon.beatLogits(models.chartSpectrogram, models.chartBeats, samples),
          alignerOutputs: (samples, progress) =>
            addon.alignerOutputs(models.chartAligner, models.chartBoundary, samples, progress, signal),
          forcedAlign: (emissions, classes, from, to, targets) =>
            addon.forcedAlignPath(emissions, classes, from, to, targets),
          transcribeNotes: (samples, requests, gameLanguage, progress) =>
            addon.transcribeNotes(models.chartNotes, samples, requests, gameLanguage, progress, signal),
          harmonicRatios: (samples, notes) => addon.harmonicRatios(samples, notes),
          predictPitchShifts: (features) => addon.predictPitchShifts(models.chartPitchFix, features),
          predictNoteEnds: (features) => addon.predictNoteEnds(models.chartNoteEnds, features),
        };
        return makeChart({ vocals16k, vocals44k, mix22k, lines, language: source.language }, engines, (step, percent) =>
          Effect.runFork(onProgress({ step: STEPS[step], done: percent, total: 100, unit: "percent" })),
        );
      },
      catch: (error) =>
        new ChartFailed({
          message:
            error instanceof AlignFailed
              ? `The lyrics couldn't be matched to the vocals (${error.message}). Check that they belong to this song.`
              : `Couldn't make the chart: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });
    yield* log.write(
      "INFO",
      "charting",
      `Made a chart: ${result.lines.flat().length} notes in ${result.lines.length} lines, ${Math.round((Date.now() - started) / 1000)} s${
        result.fit ? `, line times ${result.fit.ignored ? "ignored" : `offset ${result.fit.offset.toFixed(2)} s`}` : ""
      }`,
    );
    // The pitch it followed goes with the chart, so the editor can draw it without working it out again.
    return { chart: toProjectChart(result, details), pitch: sungMidi(result.track) };
  }).pipe(Effect.scoped);
}

/** "Make the chart" for an open project: its media and lyrics through `chartFromFiles`, written over its notes. */
export function generateChart(session: ProjectSession, onProgress: (progress: ImportProgress) => Effect.Effect<void>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const db = session.db;

    const chart = yield* readChart(db);
    const language = chartLanguage(chart.song.language);
    if (typeof language === "string") return yield* new ChartFailed({ message: language });
    const lyrics = yield* readLyrics(db);
    if (!lyrics?.lines.some((line) => line.text.trim())) {
      return yield* new ChartFailed({ message: "The song has no lyrics yet. Add them first." });
    }
    const media = yield* listMedia(db);
    const audio = media.find((row) => row.role === "audio");
    const vocals = media.find((row) => row.role === "vocals");
    if (!audio) return yield* new ChartFailed({ message: "The song has no audio." });
    if (!vocals) return yield* new ChartFailed({ message: "The song needs its vocals separated first." });

    const folder = yield* fs
      .makeTempDirectoryScoped({ prefix: "tunestudio-media-" })
      .pipe(mapFileError("a temporary folder", "create"));
    const extension = (fileName: string) => paths.extname(fileName) || ".audio";
    const vocalsFile = paths.join(folder, `vocals${extension(vocals.fileName)}`);
    const audioFile = paths.join(folder, `song${extension(audio.fileName)}`);
    yield* writeMediaToFile(db, vocals, vocalsFile);
    yield* writeMediaToFile(db, audio, audioFile);
    const generated = yield* chartFromFiles(
      { vocalsFile, audioFile, lines: lyrics.lines, language },
      chart.song,
      onProgress,
    );
    yield* db.transaction((tx) =>
      Effect.andThen(replaceChart(tx, generated.chart), writePitch(tx, vocals, generated.pitch)),
    );
    return generated.chart;
  }).pipe(Effect.scoped);
}
