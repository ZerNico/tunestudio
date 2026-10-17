/**
 * The steps main's long calls report, as main names them and the renderer's checklists and progress lines list them.
 * A model is only downloaded the first time.
 */

/** Getting a new project's song: downloading it or copying the file, then separating the voice. */
export const DOWNLOADING_THE_AUDIO = "Downloading the audio";
export const DOWNLOADING_THE_VIDEO = "Downloading the video";
export const ADJUSTING_THE_VOLUME = "Adjusting the volume";
export const COPYING_THE_SONG = "Copying the song";
export const GETTING_SEPARATION_MODEL = "Getting the voice separation model";
export const SEPARATING_THE_VOICE = "Separating the voice";

/** Hearing the lyrics in the song. */
export const GETTING_LISTENING_MODEL = "Getting the listening model";
export const LISTENING_TO_THE_SONG = "Listening to the song";

/** Writing a new project. */
export const SAVING_THE_PROJECT = "Saving the project";

/** Making a chart, in order. */
export const GETTING_CHART_MODELS = "Getting the chart models";
/** Auto pitch's step (the editor's, not the chart's). */
export const FINDING_THE_PITCH = "Finding the pitch";
export const READING_SONG = "Reading the song";
export const CHART_STEPS = {
  melody: "Following the melody",
  beat: "Finding the beat",
  timing: "Timing the lyrics",
  notes: "Writing the notes",
  finishing: "Finishing the chart",
} as const;

/** The chart checklist: every step, the model download first when the models aren't there yet. */
export function chartTasks(modelsMissing: boolean): string[] {
  return [...(modelsMissing ? [GETTING_CHART_MODELS] : []), READING_SONG, ...Object.values(CHART_STEPS)];
}
