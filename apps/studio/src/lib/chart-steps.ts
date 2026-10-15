/**
 * The steps making a chart reports, in order, as main names them and the new-project checklist lists them. The models
 * are only downloaded the first time.
 */
export const GETTING_CHART_MODELS = "Getting the chart models";
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
