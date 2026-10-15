import fs from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { DEFAULT_SETTINGS } from "../../src/lib/settings";
import { tempDir } from "../testing";
import { AppSettings, settingsLayer } from "./settings";

let cleanup = () => {};
afterEach(() => cleanup());

function setup() {
  const made = tempDir();
  cleanup = made.cleanup;
  const file = path.join(made.dir, "data", "settings.json");
  const run = <A, E>(effect: Effect.Effect<A, E, AppSettings>) =>
    Effect.runPromise(effect.pipe(Effect.provide(settingsLayer(file).pipe(Layer.provide(NodeServices.layer)))));
  return { file, run };
}

describe("AppSettings", () => {
  it("starts with the defaults and stores changes as versioned JSON", async () => {
    const { file, run } = setup();
    const changed = { ...DEFAULT_SETTINGS, audio: { ...DEFAULT_SETTINGS.audio, format: "opus" as const } };
    const stored = await run(
      Effect.gen(function* () {
        const settings = yield* AppSettings;
        expect(yield* settings.get).toEqual(DEFAULT_SETTINGS);
        yield* settings.set(changed);
        return yield* settings.get;
      }),
    );
    expect(stored).toEqual(changed);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ version: 1, settings: changed });
  });

  it("keeps valid values from an older or edited file and defaults the rest", async () => {
    const { file, run } = setup();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, settings: { audio: { format: "mp3", bitrate: 999 }, video: "nope", extra: 1 } }),
    );
    expect(await run(AppSettings.use((settings) => settings.get))).toEqual({
      ...DEFAULT_SETTINGS,
      audio: { ...DEFAULT_SETTINGS.audio, format: "mp3" },
    });
  });

  it("keeps the remembered language when the settings screen saves an older copy", async () => {
    const { run } = setup();
    const stored = await run(
      Effect.gen(function* () {
        const settings = yield* AppSettings;
        const screen = yield* settings.get;
        yield* settings.remember({ language: "de" });
        yield* settings.set({ ...screen, audio: { ...screen.audio, format: "mp3" } });
        return yield* settings.get;
      }),
    );
    expect(stored.audio.format).toBe("mp3");
    expect(stored.newProject.language).toBe("de");
  });

  it("treats a damaged file as the defaults", async () => {
    const { file, run } = setup();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(await run(AppSettings.use((settings) => settings.get))).toEqual(DEFAULT_SETTINGS);
  });
});
