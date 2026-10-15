import { randomUUID } from "node:crypto";

import { Context, Effect, FileSystem, Layer, Path, Semaphore } from "effect";

import { type FileError, mapFileError, ModelDownloadFailed } from "../errors";
import { AppLog } from "../services/app-log";
import { Downloads } from "../tools/downloads";

export const MODEL_NAMES = ["separation", "whisper"] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

/** A model file pinned to one revision of a Hugging Face repository. */
export interface ModelSource {
  /** For messages: "Couldn't download the voice separation model". */
  readonly label: string;
  readonly file: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * The models, downloaded on first use rather than shipped: Kimberley Jensen's Mel-Band RoFormer
 * vocals model as exported to ONNX by audiojs (MIT), and Whisper large-v3 turbo for whisper.cpp
 * (MIT).
 */
export const MODELS: Record<ModelName, ModelSource> = {
  separation: {
    label: "the voice separation model",
    file: "mel-roformer.fp16.onnx",
    url: "https://huggingface.co/audiojs/mel-roformer/resolve/c1aba02c00a0bee852d6754fe6ede8164f90a4b3/mel-roformer.fp16.onnx",
    sha256: "adcbbb826f12453fbb86652b503242d565a9c81cdef1bca2fe0e54752eba91ef",
    size: 464_050_097,
  },
  whisper: {
    label: "the listening model",
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    size: 574_041_195,
  },
};

export type ModelError = ModelDownloadFailed | FileError;

interface ModelsShape {
  /** Whether `model` is downloaded. */
  readonly installed: (model: ModelName) => Effect.Effect<boolean>;
  /**
   * The path of `model`, downloading it first if needed. `onBytes` gets the bytes received so
   * far and the total.
   */
  readonly ensure: (
    model: ModelName,
    onBytes?: (received: number, total: number) => Effect.Effect<void>,
  ) => Effect.Effect<string, ModelError>;
}

/** The models behind voice separation and listening, kept in the app's data folder. */
export class Models extends Context.Service<Models, ModelsShape>()("studio/Models") {}

/** Models in `folder`. Tests pass their own sources. */
export function modelsLayer(options: { folder: string; sources?: Record<ModelName, ModelSource> }) {
  const sources = options.sources ?? MODELS;
  return Layer.effect(
    Models,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const downloads = yield* Downloads;
      const log = yield* AppLog;
      const locks = Object.fromEntries(
        yield* Effect.forEach(MODEL_NAMES, (model) => Effect.map(Semaphore.make(1), (lock) => [model, lock] as const)),
      ) as Record<ModelName, Semaphore.Semaphore>;

      const fileOf = (model: ModelName) => paths.join(options.folder, sources[model].file);

      // The checksum is checked when downloading; afterwards the size is enough to catch a
      // download that was cut off, without reading half a gigabyte at every start.
      const installed = (model: ModelName) =>
        fs.stat(fileOf(model)).pipe(
          Effect.map((info) => Number(info.size) === sources[model].size),
          Effect.orElseSucceed(() => false),
        );

      const download = (model: ModelName, onBytes: (received: number, total: number) => Effect.Effect<void>) =>
        Effect.gen(function* () {
          const source = sources[model];
          yield* fs
            .makeDirectory(options.folder, { recursive: true })
            .pipe(mapFileError("the models folder", "create"));
          const partial = paths.join(options.folder, `.${source.file}.${randomUUID().slice(0, 8)}.download`);
          return yield* Effect.gen(function* () {
            const result = yield* downloads
              .file(source.url, partial, (received, total) => onBytes(received, total ?? source.size))
              .pipe(
                Effect.mapError(
                  (error) =>
                    new ModelDownloadFailed({
                      message: `Couldn't download ${source.label}: ${error.message} Check your internet connection and try again.`,
                    }),
                ),
              );
            if (result.sha256 !== source.sha256 || result.size !== source.size) {
              return yield* new ModelDownloadFailed({
                message: `The download of ${source.label} came out damaged, so it wasn't kept. Try again.`,
              });
            }
            yield* fs.rename(partial, fileOf(model)).pipe(mapFileError(source.label, "save"));
            yield* log.write("INFO", "models", `Downloaded ${source.file}`);
          }).pipe(Effect.ensuring(fs.remove(partial, { force: true }).pipe(Effect.ignore)));
        });

      return {
        installed,
        ensure: (model, onBytes = () => Effect.void) =>
          locks[model].withPermits(1)(
            Effect.gen(function* () {
              if (!(yield* installed(model))) yield* download(model, onBytes);
              return fileOf(model);
            }),
          ),
      } satisfies ModelsShape;
    }),
  );
}
