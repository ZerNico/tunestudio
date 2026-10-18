import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { GameNotFound, GameUnusable } from "../../src/lib/errors";
import type { OpenedProject, Progress } from "../../src/lib/native/types";
import { fakeGameApp, soloChart, syntheticBytes, tempDir, testRuntime, writeSong } from "../testing";
import { nativeHandlers } from "./procedures";
import { connectClient } from "./test-client";

let cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
  cleanups = [];
});

/** The app's handlers on the real services, with a desktop that records and a launcher that starts nothing. */
async function setup() {
  const { dir, cleanup } = tempDir();
  const test = testRuntime(dir);
  const { native } = await connectClient(test.runtime, nativeHandlers);
  cleanups.push(
    cleanup,
    () => test.runtime.dispose(),
    () => native.dispose(),
  );
  fs.mkdirSync(path.join(dir, "Applications"));
  return { dir, ...test, rpc: native };
}

type Rpc = Awaited<ReturnType<typeof setup>>["rpc"];

/** A song imported into a project, open. */
async function openSong(rpc: Rpc, dir: string, recorded: { answers: (string | null)[] }) {
  const folder = writeSong(dir, "Song", {
    "song.txt": soloChart(),
    "Test Artist - Night Signals.mp3": syntheticBytes(200_000, 7),
  });
  recorded.answers.push(folder);
  await rpc.dialogs.chooseSong();
  const target = path.join(dir, "Night Signals.tunestudio");
  recorded.answers.push(target);
  await rpc.dialogs.chooseProjectLocation({ name: "Night Signals" });
  const iterator = await rpc.song.import({ path: folder, includeVideo: false, target });
  for (;;) {
    const next: IteratorResult<Progress, OpenedProject> = await iterator.next();
    if (next.done) return next.value;
  }
}

describe("games", () => {
  it("lists the games, found or not, and keeps only an app that can start", async () => {
    const { dir, rpc, recorded } = await setup();
    const found = fakeGameApp(path.join(dir, "Applications"), "Tune Perfect", "tuneperfect", "#!/bin/sh\n");
    const status = await rpc.games.status();
    expect(status.last).toBeNull();
    expect(status.games).toEqual([
      { game: "tune-perfect", chosen: null, found },
      { game: "usdx", chosen: null, found: null },
      { game: "vocaluxe", chosen: null, found: null },
      { game: "performous", chosen: null, found: null },
    ]);

    // A cancelled dialog changes nothing; a file that isn't an app is refused and not kept.
    recorded.answers.push(null);
    expect(await rpc.games.choose({ game: "usdx" })).toEqual(status);
    const notes = path.join(dir, "notes.txt");
    fs.writeFileSync(notes, "x");
    recorded.answers.push(notes);
    const refused = await rpc.games.choose({ game: "usdx" }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GameUnusable);
    expect((await rpc.games.status()).games[1]!.chosen).toBeNull();

    const usdx = fakeGameApp(dir, "UltraStarDeluxe", "ultrastardx", "#!/bin/sh\n");
    recorded.answers.push(usdx);
    const chosen = await rpc.games.choose({ game: "usdx" });
    expect(chosen.games[1]).toEqual({ game: "usdx", chosen: usdx, found: usdx });
    // The settings screen's copy of the settings doesn't undo it.
    const settings = await rpc.settings.get();
    await rpc.settings.set({
      ...settings,
      games: { last: "vocaluxe", paths: { ...settings.games.paths, vocaluxe: "/bin/sh" } },
    });
    expect((await rpc.settings.get()).games).toEqual(settings.games);

    expect((await rpc.games.clear({ game: "usdx" })).games[1]).toEqual({ game: "usdx", chosen: null, found: null });
  });

  it("exports the song into its own folder and starts the game with it, replacing the last try", async () => {
    const { dir, rpc, recorded, launched } = await setup();
    const project = await openSong(rpc, dir, recorded);

    // Nothing chosen or found: nothing is exported or started.
    const none = await rpc.project.tryInGame({ id: project.id }).catch((error: unknown) => error);
    expect(none).toBeInstanceOf(GameNotFound);
    expect((none as GameNotFound).message).toBe("Tune Studio couldn't find a game. Add one in Settings.");
    const missing = await rpc.project.tryInGame({ id: project.id, game: "tune-perfect" }).catch((e: unknown) => e);
    expect((missing as GameNotFound).message).toBe("Tune Studio couldn't find Tune Perfect. Choose it in Settings.");
    expect(launched.starts).toEqual([]);

    const app = fakeGameApp(path.join(dir, "Applications"), "Tune Perfect", "tuneperfect", "#!/bin/sh\n");
    const tryFolder = path.join(dir, "data", "try-in-game");
    fs.mkdirSync(path.join(tryFolder, "Old Artist - Old Song"), { recursive: true });
    // Without a game, the first available one.
    const tried = await rpc.project.tryInGame({ id: project.id });
    const song = path.join(tryFolder, "Test Artist - Night Signals");
    expect(tried).toEqual({ game: "tune-perfect", folder: song, warnings: [] });
    expect(fs.readdirSync(tryFolder)).toEqual(["Test Artist - Night Signals"]);
    expect(fs.readdirSync(song).toSorted()).toEqual([
      "Test Artist - Night Signals.mp3",
      "Test Artist - Night Signals.txt",
    ]);
    expect(launched.starts).toEqual([
      { program: path.join(app, "Contents", "MacOS", "tuneperfect"), args: ["--songpath", song], env: {} },
    ]);

    expect((await rpc.games.status()).last).toBe("tune-perfect");

    // Performous takes the folder alone, and is tried again without naming it.
    const performous = fakeGameApp(dir, "Performous", "performous", "#!/bin/sh\n");
    recorded.answers.push(performous);
    await rpc.games.choose({ game: "performous" });
    expect((await rpc.project.tryInGame({ id: project.id, game: "performous" })).game).toBe("performous");
    expect(launched.starts.at(-1)?.args).toEqual([song]);
    expect((await rpc.project.tryInGame({ id: project.id })).game).toBe("performous");

    launched.outcome = { kind: "failed", code: "EACCES" };
    const denied = await rpc.project.tryInGame({ id: project.id }).catch((error: unknown) => error);
    expect((denied as GameUnusable).message).toBe(
      "Tune Studio isn't allowed to start Performous. Check that it is a program you can run.",
    );

    // A chosen app that went away says so when named; without a name, an available game starts instead.
    fs.rmSync(performous, { recursive: true });
    const gone = await rpc.project.tryInGame({ id: project.id, game: "performous" }).catch((e: unknown) => e);
    expect((gone as GameNotFound).message).toBe("Performous isn't where it was chosen. Choose it again in Settings.");
    launched.outcome = { kind: "started" };
    expect((await rpc.project.tryInGame({ id: project.id })).game).toBe("tune-perfect");
  });
});
