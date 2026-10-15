/**
 * The models Tune Studio downloads on first use, by what they are for, as the settings screen lists them. Each feature
 * downloads its models together (`electron/models/models.ts` has the files, their versions, credits and licenses).
 */
export const MODEL_FEATURES = ["separation", "listening", "chart"] as const;
export type ModelFeature = (typeof MODEL_FEATURES)[number];

export const MODEL_FEATURE_INFO: Record<ModelFeature, { label: string; purpose: string }> = {
  separation: {
    label: "Voice separation",
    purpose: "Separates the voice from the music when a song is downloaded.",
  },
  listening: {
    label: "Listening",
    purpose: "Writes down what is sung, for lyrics “Heard in the song”.",
  },
  chart: {
    label: "Chart making",
    purpose: "Makes the notes and their timing from the vocals and the lyrics.",
  },
};
