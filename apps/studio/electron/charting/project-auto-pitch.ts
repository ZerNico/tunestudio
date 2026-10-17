/**
 * Auto pitch for an open project's notes (`auto-pitch.ts`): its vocals decoded, the models it needs downloaded first if
 * needed, and the new pitches returned for the editor to apply (it saves them as an edit like any other).
 */
import { Effect, FileSystem, Path } from "effect";

import type { Progress } from "../../src/lib/native/types";
import { FINDING_THE_PITCH, GETTING_CHART_MODELS, READING_SONG } from "../../src/lib/steps";
import { abortable } from "../abortable";
import { ChartFailed, mapFileError } from "../errors";
import { Models } from "../models/models";
import { Native } from "../native/native";
import { readChart } from "../project/chart";
import { readEditorChart } from "../project/editor-chart";
import { listMedia, writeMediaToFile } from "../project/media";
import { sungPitch } from "../project/pitch";
import type { ProjectSession } from "../project/projects";
import { Tools } from "../tools/tools";
import { decodeMono } from "./audio";
import { autoPitch, type PitchNote } from "./auto-pitch";
import { chartEngines } from "./engines";
import { chartLanguage } from "./generate";
import { GAME_SAMPLE_RATE } from "./pipeline";
import { PITCH_SAMPLE_RATE } from "./pitch-track";

/** The models auto pitch runs: FCPE, GAME and the pitch corrector. */
const MODELS = ["chartPitch", "chartNotes", "chartPitchFix"] as const;

/** The new pitch (MIDI) of each of the notes `ids` that has something sung to go by. */
export function autoPitchNotes(
  session: ProjectSession,
  ids: readonly number[],
  onProgress: (progress: Progress) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const db = session.db;
    const chart = yield* readEditorChart(db);
    const wanted = new Set(ids);
    // Per singer: the lines the notes are in and the lines either side of them, all their notes as context (the octave
    // fix judges each note by the ones around it).
    const singers: PitchNote[][][] = chart.singers
      .map((singer) => {
        const asked = singer.lines.flatMap((line, i) => (line.notes.some((note) => wanted.has(note.id)) ? [i] : []));
        const near = new Set(asked.flatMap((i) => [i - 1, i, i + 1]));
        return singer.lines
          .filter((_, i) => near.has(i))
          .map((line) =>
            line.notes.map((note) => ({
              id: note.id,
              start: note.start,
              end: note.start + note.duration,
              pitch: note.pitch,
              type: note.type,
            })),
          );
      })
      .filter((lines) => lines.some((line) => line.some((note) => wanted.has(note.id))));
    if (!singers.length) return [];
    const vocals = (yield* listMedia(db)).find((row) => row.role === "vocals");
    if (!vocals) return yield* new ChartFailed({ message: "The song needs its vocals separated first." });
    const language = chartLanguage((yield* readChart(db)).song.language);

    const { ffmpeg } = (yield* Tools.use((tools) => tools.ensure(["ffmpeg"]))).ffmpeg;
    if (!ffmpeg) return yield* new ChartFailed({ message: "FFmpeg couldn't be installed. Try again." });
    const models = yield* (yield* Models).ensureAll(MODELS, (received, total) =>
      onProgress({ step: GETTING_CHART_MODELS, done: received, total }),
    );
    const song = yield* sungPitch(session, onProgress);
    yield* onProgress({ step: READING_SONG, done: 0, total: 0 });
    const addon = yield* (yield* Native).addon;
    const folder = yield* fs
      .makeTempDirectoryScoped({ prefix: "tunestudio-pitch-" })
      .pipe(mapFileError("a temporary folder", "create"));
    const file = paths.join(folder, `vocals${paths.extname(vocals.fileName) || ".audio"}`);
    yield* writeMediaToFile(db, vocals, file);
    const vocals16k = yield* decodeMono(ffmpeg, file, PITCH_SAMPLE_RATE, folder);
    const vocals44k = yield* decodeMono(ffmpeg, file, GAME_SAMPLE_RATE, folder);

    yield* onProgress({ step: FINDING_THE_PITCH, done: 0, total: 100, unit: "percent" });
    const pitches = new Map<number, number>();
    for (const lines of singers) {
      const found = yield* abortable({
        try: (signal) =>
          autoPitch(
            {
              vocals16k,
              vocals44k,
              lines,
              notes: wanted,
              grid: { bpm: chart.bpm, gap: chart.gap },
              songMidi: Float32Array.from(song?.midi ?? [], (value) => value ?? Number.NaN),
              // GAME only tells English from the rest; another language listens as "the rest".
              language: typeof language === "string" ? { name: "other", code: "und" } : language,
            },
            chartEngines(addon, models, signal),
            (percent) =>
              Effect.runFork(onProgress({ step: FINDING_THE_PITCH, done: percent, total: 100, unit: "percent" })),
            signal,
          ),
        catch: (error) =>
          new ChartFailed({
            message: `Couldn't find the pitch: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });
      for (const [id, pitch] of found) pitches.set(id, pitch);
    }
    return [...pitches].map(([id, pitch]) => ({ id, pitch }));
  }).pipe(Effect.scoped);
}
