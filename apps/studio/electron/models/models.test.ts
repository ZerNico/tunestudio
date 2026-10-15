import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AppLog } from "../services/app-log";
import { tempDir } from "../testing";
import { DownloadFailed, Downloads } from "../tools/downloads";
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
