/** The settings screen's view of the models: by feature, with downloading and removing a feature's models. */
import { Effect } from "effect";

import type { ModelFeature } from "../../src/lib/models";
import { MODEL_FEATURES } from "../../src/lib/models";
import type { ImportProgress, ModelFeatureStatus } from "../../src/lib/native/types";
import { FEATURE_MODELS, Models } from "./models";

/** How much of each feature's models is downloaded. */
export const modelFeatures = Effect.gen(function* () {
  const models = yield* Models;
  return yield* Effect.forEach(MODEL_FEATURES, (feature) =>
    Effect.gen(function* () {
      let downloaded = 0;
      let size = 0;
      let downloadedAt: number | null = null;
      const credits = new Map<string, ModelFeatureStatus["models"][number]>();
      for (const model of FEATURE_MODELS[feature]) {
        const source = models.source(model);
        size += source.size;
        const at = yield* models.downloadedAt(model);
        if (at !== null) {
          downloaded += source.size;
          downloadedAt = Math.max(downloadedAt ?? 0, at);
        }
        // Models made by the same people (the aligner and its head) are credited once.
        if (!credits.has(source.credit)) {
          credits.set(source.credit, { credit: source.credit, license: source.license, version: source.version });
        }
      }
      return { feature, size, downloaded, downloadedAt, models: [...credits.values()] } satisfies ModelFeatureStatus;
    }),
  );
});

/** Downloads what is missing of a feature's models, reporting the bytes; then how every feature stands. */
export function downloadFeature(
  feature: ModelFeature,
  onProgress: (progress: ImportProgress) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.gen(function* () {
    const models = yield* Models;
    yield* models.ensureAll(FEATURE_MODELS[feature], (done, total) => onProgress({ step: "Downloading", done, total }));
    return yield* modelFeatures;
  });
}

/** Deletes a feature's models; they are downloaded again when the feature is next used. */
export function removeFeature(feature: ModelFeature) {
  return Effect.gen(function* () {
    const models = yield* Models;
    yield* Effect.forEach(FEATURE_MODELS[feature], (model) => models.remove(model), { discard: true });
    return yield* modelFeatures;
  });
}
