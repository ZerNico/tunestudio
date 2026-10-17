import { Effect, FileSystem, Path, Semaphore } from "effect";

import { intersectsRange, rangeProblem } from "../../src/lib/chart-range";
import type { ChartRangeInput } from "../../src/lib/native/contract";
import type { Progress } from "../../src/lib/native/types";
import { CHART_STEPS, GETTING_CHART_MODELS, READING_SONG } from "../../src/lib/steps";
import { abortable } from "../abortable";
import { ChartFailed, mapFileError } from "../errors";
import { Models } from "../models/models";
import { Native } from "../native/native";
import { readEditorChart } from "../project/editor-chart";
import { listMedia, writeMediaToFile } from "../project/media";
import { sungPitch } from "../project/pitch";
import type { ProjectSession } from "../project/projects";
import { Tools } from "../tools/tools";
import { AlignFailed } from "./align-stage";
import { decodeMono } from "./audio";
import { chartEngines } from "./engines";
import { CHART_LANGUAGES } from "./generate";
import { GAME_SAMPLE_RATE } from "./pipeline";
import { PITCH_SAMPLE_RATE } from "./pitch-track";
import { chartRange } from "./range-chart";

const MODELS = ["chartPitch", "chartAligner", "chartBoundary", "chartNotes", "chartPitchFix", "chartNoteEnds"] as const;

/**
 * One range at a time per project: a whole song holds hundreds of MB of decoded audio. Not every model call can be
 * stopped, so a run also waits for the native work of a stopped one (`running`) to end.
 */
const locks = new WeakMap<ProjectSession, Semaphore.Semaphore>();
const running = new WeakMap<ProjectSession, Promise<unknown>>();

/** Generates a passage without writing notes. Source changes during inference invalidate the entire result. */
export function chartProjectRange(
  session: ProjectSession,
  input: ChartRangeInput,
  onProgress: (progress: Progress) => Effect.Effect<void>,
) {
  let lock = locks.get(session);
  if (!lock) locks.set(session, (lock = Semaphore.makeUnsafe(1)));
  return Effect.gen(function* () {
    const previous = running.get(session);
    if (previous)
      yield* Effect.promise(() =>
        previous.then(
          () => {},
          () => {},
        ),
      );
    const problem = rangeProblem(input, input.lines);
    if (problem) return yield* new ChartFailed({ message: problem });
    const chart = yield* readEditorChart(session.db);
    if (!Number.isFinite(chart.bpm) || chart.bpm <= 0 || !Number.isFinite(chart.gap))
      return yield* new ChartFailed({ message: "Set a valid song grid first." });
    const before = JSON.stringify(chart);
    const singer = chart.singers.find((item) => item.id === input.singerId);
    if (!singer) return yield* new ChartFailed({ message: "Choose a singer in this project." });
    if (
      singer.lines
        .flatMap((line) => line.notes)
        .some(
          (note) =>
            intersectsRange(note, input) &&
            (note.start < input.start - 1e-6 || note.start + note.duration > input.end + 1e-6),
        )
    )
      return yield* new ChartFailed({ message: "Include the whole notes at the edges of the range." });
    const sources = (yield* listMedia(session.db)).filter((row) => row.role === "vocals" || row.role === "audio");
    const stamp = JSON.stringify(sources.map((row) => [row.id, row.role, row.sha256]));
    const vocals = sources.find((row) => row.role === "vocals");
    if (!vocals) return yield* new ChartFailed({ message: "The song needs its vocals separated first." });
    if (vocals.duration !== null && input.end > vocals.duration + 1e-6)
      return yield* new ChartFailed({ message: "Choose a range inside the vocals." });
    const { ffmpeg } = (yield* Tools.use((tools) => tools.ensure(["ffmpeg"]))).ffmpeg;
    if (!ffmpeg) return yield* new ChartFailed({ message: "FFmpeg couldn't be installed. Try again." });
    const models = yield* (yield* Models).ensureAll(MODELS, (done, total) =>
      onProgress({ step: GETTING_CHART_MODELS, done, total }),
    );
    const song = yield* sungPitch(session, onProgress);
    yield* onProgress({ step: READING_SONG, done: 0, total: 0 });
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const folder = yield* fs
      .makeTempDirectoryScoped({ prefix: "tunestudio-range-" })
      .pipe(mapFileError("a temporary folder", "create"));
    const file = paths.join(folder, `vocals${paths.extname(vocals.fileName) || ".audio"}`);
    yield* writeMediaToFile(session.db, vocals, file);
    const vocals16k = yield* decodeMono(ffmpeg, file, PITCH_SAMPLE_RATE, folder);
    const vocals44k = yield* decodeMono(ffmpeg, file, GAME_SAMPLE_RATE, folder);
    const addon = yield* (yield* Native).addon;
    const result = yield* abortable({
      try: (signal) => {
        const work = chartRange(
          {
            vocals16k,
            vocals44k,
            range: input,
            lines: input.lines,
            grid: { bpm: chart.bpm, gap: chart.gap },
            songMidi: Float32Array.from(song?.midi ?? [], (value) => value ?? Number.NaN),
            language: CHART_LANGUAGES[input.language],
          },
          chartEngines(addon, models, signal),
          (step, done) => Effect.runFork(onProgress({ step: CHART_STEPS[step], done, total: 100, unit: "percent" })),
          signal,
        );
        running.set(session, work);
        return work;
      },
      catch: (error) => error,
    }).pipe(
      // What the lyrics or range can explain reaches the user; model and addon failures are defects (logged).
      Effect.catch((error) =>
        error instanceof AlignFailed ? Effect.fail(new ChartFailed({ message: error.message })) : Effect.die(error),
      ),
    );
    const afterMedia = (yield* listMedia(session.db)).filter((row) => row.role === "vocals" || row.role === "audio");
    if (
      JSON.stringify(yield* readEditorChart(session.db)) !== before ||
      JSON.stringify(afterMedia.map((row) => [row.id, row.role, row.sha256])) !== stamp
    )
      return yield* new ChartFailed({ message: "The song changed. Chart the range again." });
    return { ...result, vocals: vocals.sha256 };
  }).pipe(Effect.scoped, lock.withPermits(1));
}
