/** The models and download tools: what is installed, downloading ahead of time, removing to free the space. */
import { Effect } from "effect";

import { downloadFeature, modelFeatures, removeFeature } from "../../models/features";
import { CHART_MODELS, type ModelName, Models } from "../../models/models";
import { Tools } from "../../tools/tools";
import { type GroupHandlers, progressStream } from "./shared";

export const modelHandlers = {
  "models.status": () =>
    Effect.gen(function* () {
      const models = yield* Models;
      const has = (model: ModelName) => models.installed(model);
      return {
        separation: yield* has("separation"),
        whisper: yield* has("whisper"),
        chart: (yield* Effect.forEach(CHART_MODELS, has)).every(Boolean),
      };
    }),
  "models.list": () => modelFeatures,
  "models.download": (input) => progressStream((onProgress) => downloadFeature(input.feature, onProgress)),
  "models.remove": (input) => removeFeature(input.feature),
} satisfies GroupHandlers<"models">;

export const toolHandlers = {
  "tools.status": () => Tools.use((tools) => tools.status),
  "tools.remove": (input) => Tools.use((tools) => Effect.andThen(tools.remove(input.tool), tools.status)),
  "tools.prepare": (input) =>
    progressStream((onProgress) =>
      Effect.gen(function* () {
        const tools = yield* Tools;
        yield* tools.ensure(input.tools, { force: input.force ?? false, onProgress });
        return yield* tools.status;
      }),
    ),
} satisfies GroupHandlers<"tools">;
