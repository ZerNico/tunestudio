import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";

import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect";

import type { ModelFeature } from "../../src/lib/models";
import { abortable } from "../abortable";
import { type FileError, mapFileError, ModelDownloadFailed } from "../errors";
import { AppLog } from "../services/app-log";
import { Downloads, MODEL_HOSTS } from "../tools/downloads";
import { unzip } from "../tools/unzip";

/** The models that make a chart from a song (electron/charting), downloaded together. */
export const CHART_MODELS = [
  "chartAligner",
  "chartBoundary",
  "chartPitch",
  "chartSpectrogram",
  "chartBeats",
  "chartPitchFix",
  "chartNoteEnds",
  "chartGolden",
  "chartNotes",
] as const;
export const MODEL_NAMES = ["separation", "whisper", ...CHART_MODELS] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

/** The models behind each feature the settings screen lists. */
export const FEATURE_MODELS: Record<ModelFeature, readonly ModelName[]> = {
  separation: ["separation"],
  listening: ["whisper"],
  chart: CHART_MODELS,
};

/** One file a model's zip must contain, and its checksum. */
export interface PackedFile {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/** A model file (or zip of files) pinned to one revision, with its size and checksum. */
export interface ModelSource {
  /** For messages: "Couldn't download the voice separation model". */
  readonly label: string;
  /** Where it's kept in the models folder: the file, or for a zip, the folder of its files. */
  readonly file: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  /** Which release it is, as the settings screen shows it: a tag ("v1.0.3") or the pinned revision. */
  readonly version: string;
  /** Who made it, as the settings screen credits it; models sharing a credit are listed once. */
  readonly credit: string;
  readonly license: string;
  /** Hosts the download may come from (and redirect through); Hugging Face's by default. */
  readonly hosts?: readonly string[];
  /** A zip: the folder inside it that holds the model, and the files kept from it. */
  readonly unpack?: { readonly folder: string; readonly files: readonly PackedFile[] };
}

/** What was downloaded of each model and when (`installed.json` in the models folder). */
const Installed = Schema.Struct({
  version: Schema.Literal(1),
  models: Schema.Record(Schema.String, Schema.Struct({ sha256: Schema.String, downloadedAt: Schema.Number })),
});
type Installed = typeof Installed.Type;
const decodeInstalled = Schema.decodeUnknownEffect(Schema.fromJsonString(Installed));

/** SHA-256 of a file, read in chunks. */
function fileSha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Where GitHub release downloads come from (the release page redirects to its asset storage). */
const GITHUB_RELEASE_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];

/** A file of the tuneperfect/<repo> Hugging Face repository at `revision`. */
const tuneperfect = (repo: string, revision: string, file: string) =>
  `https://huggingface.co/tuneperfect/${repo}/resolve/${revision}/${file}`;
const ALIGNER = "4c6edce202fae335e6239c09ea17ecddcf29b42e";
const REFINERS = "a770e8194a70c5b5f7dce8ab3b44fbe77db1a5a0";

/**
 * The models, downloaded on first use rather than shipped: Kimberley Jensen's Mel-Band RoFormer
 * vocals model as exported to ONNX by audiojs (MIT), Whisper large-v3 turbo for whisper.cpp
 * (MIT), and the chart models in tuneperfect's repositories: our aligner fine-tuned on singing and
 * its syllable-start head (CC BY-NC 4.0, from Meta's MMS), our note refiners (MIT), ONNX exports of
 * FCPE (MIT, CN_ChiTu) and Beat This! (MIT, CPJKU), and openvpi's GAME as released (its ONNX
 * files, CC BY-NC-SA 4.0).
 */
export const MODELS: Record<ModelName, ModelSource> = {
  separation: {
    version: "c1aba02",
    credit: "Mel-Band RoFormer by Kimberley Jensen, ONNX export by audiojs",
    license: "MIT",
    label: "the voice separation model",
    file: "mel-roformer.fp16.onnx",
    url: "https://huggingface.co/audiojs/mel-roformer/resolve/c1aba02c00a0bee852d6754fe6ede8164f90a4b3/mel-roformer.fp16.onnx",
    sha256: "adcbbb826f12453fbb86652b503242d565a9c81cdef1bca2fe0e54752eba91ef",
    size: 464_050_097,
  },
  whisper: {
    version: "5359861",
    credit: "Whisper large-v3 turbo by OpenAI, for whisper.cpp",
    license: "MIT",
    label: "the listening model",
    file: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin",
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    size: 574_041_195,
  },
  chartAligner: {
    version: ALIGNER.slice(0, 7),
    credit: "Lyrics aligner: Meta's MMS, fine-tuned on singing",
    license: "CC BY-NC 4.0",
    label: "the lyrics aligner",
    file: "charting/aligner.onnx",
    url: tuneperfect("tunestudio-aligner", ALIGNER, "aligner.onnx"),
    sha256: "597a1d775df8f7fe3c94310568751ef9253645b4d8cdf21bb7a3da1ab80225a1",
    size: 1_262_284_621,
  },
  chartBoundary: {
    version: ALIGNER.slice(0, 7),
    credit: "Lyrics aligner: Meta's MMS, fine-tuned on singing",
    license: "CC BY-NC 4.0",
    label: "the syllable model",
    file: "charting/boundary.onnx",
    url: tuneperfect("tunestudio-aligner", ALIGNER, "boundary.onnx"),
    sha256: "c408211885ef43a867cfb107e52eaa7399a3df84985764c578a72c8949252736",
    size: 2_570_198,
  },
  chartPitch: {
    version: "f99224c",
    credit: "Pitch: FCPE by CN_ChiTu",
    license: "MIT",
    label: "the pitch model",
    file: "charting/fcpe.onnx",
    url: tuneperfect("fcpe-onnx", "f99224c40e48c8c84fa9935ff2cc6c3e92ec6ccf", "fcpe.onnx"),
    sha256: "09c5717de92ddd5e4efc5177104f973d205102b2b5596ba91eeb19711cb90d12",
    size: 47_805_126,
  },
  chartSpectrogram: {
    version: "93b53ff",
    credit: "Beat: Beat This! by CPJKU",
    license: "MIT",
    label: "the beat model",
    file: "charting/logmel.onnx",
    url: tuneperfect("beat-this-onnx", "93b53ffd41d7c69044b658a298b12278318c614d", "logmel.onnx"),
    sha256: "161bf43d3c258a3f5e98c609721dca6d259b8c75404a56c4c135ddd36dcdd8ad",
    size: 4_469_774,
  },
  chartBeats: {
    version: "93b53ff",
    credit: "Beat: Beat This! by CPJKU",
    license: "MIT",
    label: "the beat model",
    file: "charting/beat_this.onnx",
    url: tuneperfect("beat-this-onnx", "93b53ffd41d7c69044b658a298b12278318c614d", "beat_this.onnx"),
    sha256: "926847099887de0d577509824846c89797b02fb28e35fc004c3add149c465891",
    size: 81_935_641,
  },
  chartPitchFix: {
    version: REFINERS.slice(0, 7),
    credit: "Note refiners by Tune Studio",
    license: "MIT",
    label: "the pitch corrector",
    file: "charting/notefix.onnx",
    url: tuneperfect("tunestudio-note-refiners", REFINERS, "notefix.onnx"),
    sha256: "87c66621cdf07fa7d1fe481638c23d2ec868367a0908be75c83974d74cea52f7",
    size: 4_630_937,
  },
  chartNoteEnds: {
    version: REFINERS.slice(0, 7),
    credit: "Note refiners by Tune Studio",
    license: "MIT",
    label: "the note-end model",
    file: "charting/ends.onnx",
    url: tuneperfect("tunestudio-note-refiners", REFINERS, "ends.onnx"),
    sha256: "2c525b7c939f9c9d5961393783a594900d7ca52572f7014053f43d196e9cbb10",
    size: 917_242,
  },
  chartGolden: {
    version: REFINERS.slice(0, 7),
    credit: "Note refiners by Tune Studio",
    license: "MIT",
    label: "the golden-note model",
    file: "charting/golden.onnx",
    url: tuneperfect("tunestudio-note-refiners", REFINERS, "golden.onnx"),
    sha256: "9902e7195046d0211f8745d31d47f730220d16d19ecb5e592da865b8deeb243f",
    size: 685_192,
  },
  chartNotes: {
    version: "v1.0.3",
    credit: "Notes: GAME by openvpi",
    license: "CC BY-NC-SA 4.0",
    label: "the note model",
    file: "charting/game",
    url: "https://github.com/openvpi/GAME/releases/download/v1.0.3/GAME-1.0.3-large-onnx.zip",
    sha256: "8a5480539fe7d995800dc0efe149b83a1cd4f4e4a36aa2a1f7665f1765dcac08",
    size: 361_619_205,
    hosts: GITHUB_RELEASE_HOSTS,
    unpack: {
      folder: "GAME-1.0.3-large-onnx",
      files: [
        {
          name: "encoder.onnx",
          size: 80_398_908,
          sha256: "fbda7df8791d5cafd02ed33c65f9926c5514c750278c27fb8a59259b4c1d7464",
        },
        {
          name: "segmenter.onnx",
          size: 159_935_922,
          sha256: "bf05ba683f47f605bc154519032bee0141d3630febccb40e9545ab4a92b28e66",
        },
        {
          name: "estimator.onnx",
          size: 153_459_702,
          sha256: "0d4a6e13bf475f79967e252b401bb5f317aa6b96bbe6665d5f8b14b42b179926",
        },
        {
          name: "dur2bd.onnx",
          size: 2_632,
          sha256: "49d10d1ea186e43c51fd2c51cedb01a3852d363f1c7056ae77df50f7e8dd0996",
        },
        {
          name: "bd2dur.onnx",
          size: 4_569,
          sha256: "6672d56b00f27a20e9bfaa92801c15e394bb520e49031d3ed2515b0a6cf27402",
        },
      ],
    },
  },
};

export type ModelError = ModelDownloadFailed | FileError;

interface ModelsShape {
  /** Whether `model` is downloaded, in the version this app pins. */
  readonly installed: (model: ModelName) => Effect.Effect<boolean>;
  /** When `model` was downloaded (ms since the epoch), or null when it isn't. */
  readonly downloadedAt: (model: ModelName) => Effect.Effect<number | null>;
  /**
   * The path of `model`, downloading it first if needed. `onBytes` gets the bytes received so
   * far and the total.
   */
  readonly ensure: (
    model: ModelName,
    onBytes?: (received: number, total: number) => Effect.Effect<void>,
  ) => Effect.Effect<string, ModelError>;
  /**
   * The paths of `models`, downloading the missing ones first, one after another. `onBytes` gets
   * the bytes received and the total over all of them.
   */
  readonly ensureAll: <M extends ModelName>(
    models: readonly M[],
    onBytes?: (received: number, total: number) => Effect.Effect<void>,
  ) => Effect.Effect<Record<M, string>, ModelError>;
  /** Where `model` comes from: its size, version, credit and license. */
  readonly source: (model: ModelName) => ModelSource;
  /** Deletes `model` (waiting while it is being downloaded); it is downloaded again when needed. */
  readonly remove: (model: ModelName) => Effect.Effect<void, FileError>;
}

/** The models behind voice separation and listening, kept in the app's data folder. */
export class Models extends Context.Service<Models, ModelsShape>()("studio/Models") {}

/** What a download (`.<file>.<id>.download`), an unpack or a record write leaves while it runs. */
const LEFTOVER = /^(\..+\.[0-9a-f]{8}\.(download|unpack)|installed\.json\.[0-9a-f]{8}\.tmp)$/;

/** Models in `folder`. Tests pass their own sources. */
export function modelsLayer(options: { folder: string; sources?: Partial<Record<ModelName, ModelSource>> }) {
  const sources: Record<ModelName, ModelSource> = { ...MODELS, ...options.sources };
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

      // Downloads and unpacked zips a crash or a quit cut off; only one Tune Studio runs at a time, so none is ours.
      const folders = new Set([options.folder, ...MODEL_NAMES.map((model) => paths.dirname(fileOf(model)))]);
      yield* Effect.forEach(
        folders,
        (folder) =>
          Effect.gen(function* () {
            const entries = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
            const leftovers = entries.filter((entry) => LEFTOVER.test(entry));
            yield* Effect.forEach(
              leftovers,
              (entry) => fs.remove(paths.join(folder, entry), { recursive: true, force: true }).pipe(Effect.ignore),
              { discard: true },
            );
          }),
        { discard: true },
      );

      const hasSize = (file: string, size: number) =>
        fs.stat(file).pipe(
          Effect.map((info) => info.type === "File" && Number(info.size) === size),
          Effect.orElseSucceed(() => false),
        );

      // The checksum is checked when downloading and recorded with it; afterwards the size is enough to catch a
      // download that was cut off, without reading half a gigabyte at every start.
      const sizesMatch = (model: ModelName) => {
        const { unpack, size } = sources[model];
        if (!unpack) return hasSize(fileOf(model), size);
        return Effect.map(
          Effect.forEach(unpack.files, (packed) => hasSize(paths.join(fileOf(model), packed.name), packed.size)),
          (found) => found.every(Boolean),
        );
      };

      const installedFile = paths.join(options.folder, "installed.json");
      const manifestLock = yield* Semaphore.make(1);
      const readInstalled = fs.readFileString(installedFile).pipe(
        Effect.flatMap(decodeInstalled),
        Effect.orElseSucceed((): Installed => ({ version: 1, models: {} })),
      );
      /** Changes the record of what is downloaded (a failure to write only means checking again later). */
      const updateInstalled = (change: (models: Installed["models"]) => Installed["models"]) =>
        manifestLock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* readInstalled;
            const next: Installed = { version: 1, models: change({ ...current.models }) };
            const temporary = `${installedFile}.${randomUUID().slice(0, 8)}.tmp`;
            yield* fs.makeDirectory(options.folder, { recursive: true });
            yield* fs.writeFileString(temporary, `${JSON.stringify(next, null, 2)}\n`);
            yield* fs.rename(temporary, installedFile);
          }).pipe(Effect.ignore),
        );
      const record = (model: ModelName, downloadedAt: number) =>
        updateInstalled((models) => ({ ...models, [model]: { sha256: sources[model].sha256, downloadedAt } }));

      /**
       * A model downloaded before downloads were recorded: checked once by its checksums, then recorded with its
       * file's date. One that isn't the pinned version doesn't count, so it is downloaded again.
       */
      const adopt = (model: ModelName) =>
        Effect.gen(function* () {
          const { unpack, sha256 } = sources[model];
          const checks = unpack
            ? unpack.files.map((packed) => [paths.join(fileOf(model), packed.name), packed.sha256] as const)
            : [[fileOf(model), sha256] as const];
          for (const [file, expected] of checks) {
            const actual = yield* Effect.tryPromise(() => fileSha256(file)).pipe(Effect.orElseSucceed(() => ""));
            if (actual !== expected) return false;
          }
          const modified = yield* fs.stat(checks[0]![0]).pipe(
            Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime()),
            Effect.orElseSucceed(() => undefined),
          );
          yield* record(model, modified ?? (yield* Clock.currentTimeMillis));
          return true;
        });

      const installed = (model: ModelName) =>
        Effect.gen(function* () {
          if (!(yield* sizesMatch(model))) return false;
          const entry = (yield* readInstalled).models[model];
          if (entry) return entry.sha256 === sources[model].sha256;
          return yield* adopt(model);
        });

      /** Unpacks a downloaded zip next to the model's folder, checks every file, then moves it into place. */
      const unpackInto = (model: ModelName, zip: string) =>
        Effect.gen(function* () {
          const source = sources[model];
          const { folder, files } = source.unpack!;
          const scratch = paths.join(
            paths.dirname(fileOf(model)),
            `.${paths.basename(source.file)}.${randomUUID().slice(0, 8)}.unpack`,
          );
          const damaged = () =>
            new ModelDownloadFailed({
              message: `The download of ${source.label} came out damaged, so it wasn't kept. Try again.`,
            });
          return yield* Effect.gen(function* () {
            // Stopped meanwhile, it finishes unpacking before its folder is removed.
            yield* abortable({ try: () => unzip(zip, scratch), catch: damaged });
            for (const packed of files) {
              const file = paths.join(scratch, folder, packed.name);
              const sha256 = yield* Effect.tryPromise({ try: () => fileSha256(file), catch: damaged });
              if (sha256 !== packed.sha256 || !(yield* hasSize(file, packed.size))) return yield* damaged();
            }
            yield* fs.remove(fileOf(model), { recursive: true, force: true }).pipe(Effect.ignore);
            yield* fs.rename(paths.join(scratch, folder), fileOf(model)).pipe(mapFileError(source.label, "save"));
          }).pipe(Effect.ensuring(fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore)));
        });

      const download = (model: ModelName, onBytes: (received: number, total: number) => Effect.Effect<void>) =>
        Effect.gen(function* () {
          const source = sources[model];
          yield* fs
            .makeDirectory(paths.dirname(fileOf(model)), { recursive: true })
            .pipe(mapFileError("the models folder", "create"));
          const partial = paths.join(
            paths.dirname(fileOf(model)),
            `.${paths.basename(source.file)}.${randomUUID().slice(0, 8)}.download`,
          );
          return yield* Effect.gen(function* () {
            const result = yield* downloads
              .file(source.url, partial, (received, total) => onBytes(received, total ?? source.size), {
                hosts: source.hosts ?? MODEL_HOSTS,
                maxBytes: source.size,
              })
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
            if (source.unpack) yield* unpackInto(model, partial);
            else yield* fs.rename(partial, fileOf(model)).pipe(mapFileError(source.label, "save"));
            yield* record(model, yield* Clock.currentTimeMillis);
            yield* log.write("INFO", "models", `Downloaded ${source.file} (${source.version})`);
          }).pipe(Effect.ensuring(fs.remove(partial, { force: true }).pipe(Effect.ignore)));
        });

      const ensure = (
        model: ModelName,
        onBytes: (received: number, total: number) => Effect.Effect<void> = () => Effect.void,
      ) =>
        locks[model].withPermits(1)(
          Effect.gen(function* () {
            if (!(yield* installed(model))) yield* download(model, onBytes);
            return fileOf(model);
          }),
        );

      return {
        installed,
        downloadedAt: (model) =>
          Effect.gen(function* () {
            if (!(yield* installed(model))) return null;
            return (yield* readInstalled).models[model]?.downloadedAt ?? null;
          }),
        ensure,
        source: (model) => sources[model],
        remove: (model) =>
          locks[model].withPermits(1)(
            Effect.gen(function* () {
              yield* fs
                .remove(fileOf(model), { recursive: true, force: true })
                .pipe(mapFileError(sources[model].label, "delete"));
              yield* updateInstalled(({ [model]: _removed, ...rest }) => rest);
            }),
          ),
        ensureAll: (models, onBytes = () => Effect.void) =>
          Effect.gen(function* () {
            const missing = yield* Effect.filter(models, (model) => Effect.map(installed(model), (has) => !has));
            const total = missing.reduce((sum, model) => sum + sources[model].size, 0);
            let done = 0;
            const out = {} as Record<(typeof models)[number], string>;
            for (const model of models) {
              out[model] = yield* ensure(model, (received) => onBytes(done + received, total));
              if (missing.includes(model)) done += sources[model].size;
            }
            return out;
          }),
      } satisfies ModelsShape;
    }),
  );
}
