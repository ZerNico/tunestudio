/**
 * Making a chart in setup (`drafts`): the vocals, song and lyrics through the chart pipeline (pipeline.ts), with the
 * chart models downloaded first if needed; and which languages a chart can be made in.
 */
import { Effect, FileSystem } from "effect";

import type { Progress } from "../../src/lib/native/types";
import { CHART_STEPS, GETTING_CHART_MODELS, READING_SONG } from "../../src/lib/steps";
import { abortable } from "../abortable";
import { ChartFailed, mapFileError } from "../errors";
import { CHART_MODELS, Models } from "../models/models";
import { Native } from "../native/native";
import { sungMidi } from "../project/pitch";
import { AppLog } from "../services/app-log";
import { Tools } from "../tools/tools";
import { AlignFailed, type LyricLine } from "./align-stage";
import { decodeMono } from "./audio";
import { chartEngines } from "./engines";
import { GAME_SAMPLE_RATE, makeChart, type ChartLanguage, type ChartStep } from "./pipeline";
import { PITCH_SAMPLE_RATE } from "./pitch-track";
import { toProjectChart, type ChartSongDetails } from "./project-chart";

const STEPS: Record<ChartStep, string> = CHART_STEPS;
const BEAT_SAMPLE_RATE = 22_050;

/** The languages charts can be made in so far, by ISO 639-1 code. */
export const CHART_LANGUAGES = {
  en: { name: "english", code: "eng" },
  de: { name: "german", code: "deu" },
} as const satisfies Record<string, ChartLanguage>;

/** The chart language for a project's languages (its first one, by the name projects store), or why there is none. */
export function chartLanguage(languages: readonly string[]): ChartLanguage | string {
  const first = languages[0];
  if (!first) return "Set the song's language first.";
  const name = first.trim().toLowerCase();
  return (
    Object.values(CHART_LANGUAGES).find((language) => language.name === name) ??
    `Charts can't be made in ${first} yet, only in English and German.`
  );
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
  onProgress: (progress: Progress) => Effect.Effect<void>,
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
    const result = yield* abortable({
      try: (signal) => {
        return makeChart(
          { vocals16k, vocals44k, mix22k, lines, language: source.language },
          chartEngines(addon, models, signal),
          (step, percent) =>
            Effect.runFork(onProgress({ step: STEPS[step], done: percent, total: 100, unit: "percent" })),
          signal,
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
