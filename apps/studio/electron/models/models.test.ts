import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AppLog } from "../services/app-log";
import { tempDir, zipOf } from "../testing";
import { DownloadFailed, Downloads } from "../tools/downloads";
import { downloadFeature, modelFeatures, removeFeature } from "./features";
import { type ModelName, type ModelSource, Models, modelsLayer } from "./models";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

const BYTES = Buffer.from("separation model weights");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const source = (overrides: Partial<ModelSource> = {}): ModelSource => ({
  label: "the voice separation model",
  file: "model.onnx",
  url: "https://huggingface.co/owner/repo/resolve/abc/model.onnx",
  sha256: sha256(BYTES),
  size: BYTES.length,
  version: "abc",
  credit: "Someone",
  license: "MIT",
  ...overrides,
});

/** Models in a temp folder, downloaded from a fake internet that serves `served` (or is offline). */
function setup(options: { served?: Buffer; sources?: Partial<Record<ModelName, ModelSource>> } = {}) {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const folder = path.join(dir, "models");
  const requested: string[] = [];
  const downloads = Layer.succeed(Downloads, {
    json: (url) => Effect.fail(new DownloadFailed({ url, message: "No connection." })),
    text: (url) => Effect.fail(new DownloadFailed({ url, message: "No connection." })),
    redirect: (url) => Effect.fail(new DownloadFailed({ url, message: "No connection." })),
    file: (url, file, onBytes) =>
      Effect.gen(function* () {
        requested.push(url);
        const served = options.served;
        if (!served) return yield* new DownloadFailed({ url, message: "No connection." });
        fs.writeFileSync(file, served);
        yield* onBytes(served.length / 2, null);
        yield* onBytes(served.length, null);
        return { sha256: sha256(served), size: served.length };
      }),
  });
  const log = Layer.succeed(AppLog, { write: () => Effect.void });
  const layer = modelsLayer({
    folder,
    sources: { separation: source(), whisper: source({ file: "whisper.bin" }), ...options.sources },
  }).pipe(Layer.provide(Layer.mergeAll(downloads, log, NodeServices.layer)));
  return { folder, layer, requested };
}

describe("Models", () => {
  it.effect("downloads a model on first use, reporting progress, and keeps it", () => {
    const { folder, layer, requested } = setup({ served: BYTES });
    const progress: [number, number][] = [];
    return Effect.gen(function* () {
      const models = yield* Models;
      expect(yield* models.installed("separation")).toBe(false);
      const file = yield* models.ensure("separation", (received, total) =>
        Effect.sync(() => void progress.push([received, total])),
      );
      expect(file).toBe(path.join(folder, "model.onnx"));
      expect(fs.readFileSync(file)).toEqual(BYTES);
      // Without a size from the server, the known size is the total.
      expect(progress).toEqual([
        [BYTES.length / 2, BYTES.length],
        [BYTES.length, BYTES.length],
      ]);
      expect(yield* models.installed("separation")).toBe(true);
      expect(yield* models.installed("whisper")).toBe(false);

      // Once there, it is used without downloading again.
      expect(yield* models.ensure("separation")).toBe(file);
      expect(requested).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the features' models and downloads or removes them together", () => {
    const { folder, layer } = setup({ served: BYTES });
    const progress: number[] = [];
    return Effect.gen(function* () {
      const before = yield* modelFeatures;
      expect(before.find((entry) => entry.feature === "separation")).toEqual({
        feature: "separation",
        size: BYTES.length,
        downloaded: 0,
        downloadedAt: null,
        models: [{ credit: "Someone", license: "MIT", version: "abc" }],
      });
      const after = yield* downloadFeature("separation", (step) => Effect.sync(() => void progress.push(step.done)));
      expect(after.find((entry) => entry.feature === "separation")?.downloaded).toBe(BYTES.length);
      expect(progress.at(-1)).toBe(BYTES.length);
      // Only that feature's models.
      expect(after.find((entry) => entry.feature === "listening")?.downloaded).toBe(0);

      const removed = yield* removeFeature("separation");
      expect(removed.find((entry) => entry.feature === "separation")?.downloaded).toBe(0);
      expect(fs.existsSync(path.join(folder, "model.onnx"))).toBe(false);
      // Removing what isn't there is fine.
      yield* removeFeature("listening");
    }).pipe(Effect.provide(layer));
  });

  it.effect("throws away a download that doesn't match the checksum", () => {
    const { folder, layer } = setup({ served: Buffer.from("something else entirely!") });
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Models).ensure("separation"));
      expect(error).toMatchObject({
        _tag: "ModelDownloadFailed",
        message: "The download of the voice separation model came out damaged, so it wasn't kept. Try again.",
      });
      expect(fs.readdirSync(folder)).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("says what to do when offline", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Models).ensure("whisper"));
      expect(error.message).toBe(
        "Couldn't download the voice separation model: No connection. Check your internet connection and try again.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("downloads a group of models with one progress over all of them", () => {
    const { folder, layer, requested } = setup({
      served: BYTES,
      sources: {
        chartPitch: source({ file: "charting/pitch.onnx", url: "https://huggingface.co/a/b/resolve/c/pitch.onnx" }),
        chartBeats: source({ file: "charting/beats.onnx", url: "https://huggingface.co/a/b/resolve/c/beats.onnx" }),
      },
    });
    const progress: [number, number][] = [];
    return Effect.gen(function* () {
      const models = yield* Models;
      yield* models.ensure("chartPitch");
      const files = yield* models.ensureAll(["chartPitch", "chartBeats"], (received, total) =>
        Effect.sync(() => void progress.push([received, total])),
      );
      expect(files).toEqual({
        chartPitch: path.join(folder, "charting/pitch.onnx"),
        chartBeats: path.join(folder, "charting/beats.onnx"),
      });
      // Only the missing one is downloaded, and the total counts only it.
      expect(requested).toHaveLength(2);
      expect(progress).toEqual([
        [BYTES.length / 2, BYTES.length],
        [BYTES.length, BYTES.length],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("unpacks a zipped model, checking every file it keeps", () => {
    const weights = Buffer.from("encoder weights");
    const zip = zipOf([
      { name: "GAME/" },
      { name: "GAME/encoder.onnx", data: weights.toString() },
      { name: "GAME/README.md", data: "not kept" },
    ]);
    const packed = (overrides: Partial<ModelSource> = {}) =>
      source({
        file: "charting/game",
        url: "https://github.com/owner/repo/releases/download/v1/game.zip",
        sha256: sha256(zip),
        size: zip.length,
        unpack: { folder: "GAME", files: [{ name: "encoder.onnx", size: weights.length, sha256: sha256(weights) }] },
        ...overrides,
      });
    const good = setup({ served: zip, sources: { chartNotes: packed() } });
    const bad = setup({
      served: zip,
      sources: {
        chartNotes: packed({
          unpack: { folder: "GAME", files: [{ name: "encoder.onnx", size: weights.length, sha256: "0".repeat(64) }] },
        }),
      },
    });
    return Effect.gen(function* () {
      const folder = yield* Effect.provide(
        Effect.gen(function* () {
          const models = yield* Models;
          expect(yield* models.installed("chartNotes")).toBe(false);
          const folder = yield* models.ensure("chartNotes");
          expect(yield* models.installed("chartNotes")).toBe(true);
          return folder;
        }),
        good.layer,
      );
      expect(folder).toBe(path.join(good.folder, "charting/game"));
      expect(fs.readFileSync(path.join(folder, "encoder.onnx"))).toEqual(weights);
      // Nothing else is left behind: no zip, no unpack folder.
      expect(fs.readdirSync(path.join(good.folder, "charting"))).toEqual(["game"]);

      const error = yield* Effect.flip(
        Effect.provide(
          Effect.flatMap(Models, (models) => models.ensure("chartNotes")),
          bad.layer,
        ),
      );
      expect(error.message).toBe(
        "The download of the voice separation model came out damaged, so it wasn't kept. Try again.",
      );
      expect(fs.readdirSync(path.join(bad.folder, "charting"))).toEqual([]);
    });
  });

  it.effect("records what was downloaded and when, and downloads again when the app pins another version", () => {
    const { folder, layer, requested } = setup({ served: BYTES });
    return Effect.gen(function* () {
      const models = yield* Models;
      expect(yield* models.downloadedAt("separation")).toBeNull();
      yield* models.ensure("separation");
      const installed = JSON.parse(fs.readFileSync(path.join(folder, "installed.json"), "utf8"));
      expect(installed.models.separation).toEqual({ sha256: sha256(BYTES), downloadedAt: expect.any(Number) });
      expect(yield* models.downloadedAt("separation")).toBe(installed.models.separation.downloadedAt);

      // The same size, but recorded as another version: an update pinned a new file.
      installed.models.separation.sha256 = "older";
      fs.writeFileSync(path.join(folder, "installed.json"), JSON.stringify(installed));
      expect(yield* models.installed("separation")).toBe(false);
      yield* models.ensure("separation");
      expect(requested).toHaveLength(2);
      expect(yield* models.installed("separation")).toBe(true);

      yield* models.remove("separation");
      expect(yield* models.downloadedAt("separation")).toBeNull();
      expect(JSON.parse(fs.readFileSync(path.join(folder, "installed.json"), "utf8")).models).toEqual({});
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a model downloaded before downloads were recorded, once its checksum matches", () => {
    const { folder, layer, requested } = setup({ served: BYTES });
    return Effect.gen(function* () {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "model.onnx"), BYTES);
      // Same size, other contents: not the pinned version.
      fs.writeFileSync(path.join(folder, "whisper.bin"), Buffer.alloc(BYTES.length));
      const models = yield* Models;
      expect(yield* models.installed("separation")).toBe(true);
      // Dated by its file.
      expect(yield* models.downloadedAt("separation")).toBe(
        Math.floor(fs.statSync(path.join(folder, "model.onnx")).mtimeMs),
      );
      expect(yield* models.installed("whisper")).toBe(false);
      expect(requested).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("downloads again when the file was cut off", () => {
    const { folder, layer, requested } = setup({ served: BYTES });
    return Effect.gen(function* () {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "model.onnx"), BYTES.subarray(0, 5));
      const models = yield* Models;
      expect(yield* models.installed("separation")).toBe(false);
      yield* models.ensure("separation");
      expect(fs.readFileSync(path.join(folder, "model.onnx"))).toEqual(BYTES);
      expect(requested).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});
