import type { CHART_MODELS } from "../models/models";
import type { NativeAddon } from "../native/native";
import type { ChartEngines } from "./pipeline";

type ChartModel = (typeof CHART_MODELS)[number];

/**
 * The chart's engines on the native addon, with the model paths bound in; `signal` stops the long runs. `models` are
 * the ones the caller downloaded: an engine whose model isn't among them is never to be called.
 */
export function chartEngines(
  addon: NativeAddon,
  models: Partial<Record<ChartModel, string>>,
  signal: AbortSignal,
): ChartEngines {
  const path = (model: ChartModel) => {
    const found = models[model];
    if (found === undefined) throw new Error(`The ${model} model wasn't downloaded.`);
    return found;
  };
  return {
    trackPitch: (samples) => addon.trackPitch(path("chartPitch"), samples),
    beatLogits: (samples) => addon.beatLogits(path("chartSpectrogram"), path("chartBeats"), samples),
    alignerOutputs: (samples, progress) =>
      addon.alignerOutputs(path("chartAligner"), path("chartBoundary"), samples, progress, signal),
    forcedAlign: (emissions, classes, from, to, targets) =>
      addon.forcedAlignPath(emissions, classes, from, to, targets),
    transcribeNotes: (samples, requests, language, progress) =>
      addon.transcribeNotes(path("chartNotes"), samples, requests, language, progress, signal),
    harmonicRatios: (samples, notes) => addon.harmonicRatios(samples, notes),
    predictPitchShifts: (features) => addon.predictPitchShifts(path("chartPitchFix"), features),
    predictNoteEnds: (features) => addon.predictNoteEnds(path("chartNoteEnds"), features),
  };
}
