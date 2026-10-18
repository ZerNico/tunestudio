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

  it("keeps the games as main stored them, whatever the screen sends", async () => {
    const { file, run } = setup();
    const stored = await run(
      Effect.gen(function* () {
        const settings = yield* AppSettings;
        const screen = yield* settings.get;
        yield* settings.setGames({ last: "usdx", paths: { usdx: "/Applications/UltraStarDeluxe.app" } });
        yield* settings.set({
          ...screen,
          games: { last: "vocaluxe", paths: { ...screen.games.paths, vocaluxe: "/bin/sh" } },
        });
        return yield* settings.get;
      }),
    );
    expect(stored.games).toEqual({
      last: "usdx",
      paths: { ...DEFAULT_SETTINGS.games.paths, usdx: "/Applications/UltraStarDeluxe.app" },
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).settings.games.paths.usdx).toBe(
      "/Applications/UltraStarDeluxe.app",
    );
    // Cleared again.
    const cleared = await run(AppSettings.use((settings) => settings.setGames({ paths: { usdx: null } })));
    expect(cleared.games.paths.usdx).toBeNull();
  });

  it("defaults a stored game that isn't one, keeps the other games' paths and drops keys it doesn't know", async () => {
    const { file, run } = setup();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        settings: {
          games: { last: "singstar", tryWith: "usdx", paths: { performous: "/opt/performous", usdx: 3, other: "/x" } },
        },
      }),
    );
    expect((await run(AppSettings.use((settings) => settings.get))).games).toEqual({
      last: null,
      paths: { "tune-perfect": null, usdx: null, vocaluxe: null, performous: "/opt/performous" },
    });
  });

  it("treats a damaged file as the defaults", async () => {
    const { file, run } = setup();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(await run(AppSettings.use((settings) => settings.get))).toEqual(DEFAULT_SETTINGS);
  });
});
