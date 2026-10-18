import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { launchStudio, type Studio } from "./app.ts";
import { answerDialogs, fakeGame, type SongFixture, songFixture, stubDesktop } from "./fixtures.ts";

let studio: Studio;
let song: SongFixture;

test.skip(process.platform === "win32", "the fake game is a shell script");

test.beforeEach(async () => {
  song = songFixture();
  studio = await launchStudio({ width: 1280, height: 820 });
  await stubDesktop(studio.app);
});

test.afterEach(async () => {
  await studio.close();
  song.cleanup();
});

test("tries the song in a game: asks for one first, then exports it and starts the game with its folder", async () => {
  const { app, page } = studio;
  const projectFile = path.join(song.dir, "Night Signals.tunestudio");
  await answerDialogs(app, song.folder, projectFile);
  await page.getByTestId("song-choose").click();
  await page.getByTestId("flow-next").click();
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("project")).toBeVisible();

  // No game anywhere: the toast leads to the settings' Games section.
  await page.getByTestId("export-song").click();
  await page.getByRole("menuitem", { name: /Try in Tune Perfect/ }).click();
  await expect(page.getByText("Tune Studio couldn't find Tune Perfect. Choose it in Settings.")).toBeVisible();
  await page.getByRole("button", { name: "Open Settings" }).click();
  const games = page.getByTestId("settings-games");
  await expect(games).toBeInViewport();
  await expect(page.getByTestId("game-tune-perfect-path")).toHaveText("Not set");

  const gamesFolder = path.join(song.dir, "Games");
  fs.mkdirSync(gamesFolder);
  const game = fakeGame(gamesFolder, "Tune Perfect", "tuneperfect");
  await answerDialogs(app, game.app);
  await page.getByRole("button", { name: "Choose Tune Perfect" }).click();
  await expect(page.getByTestId("game-tune-perfect-path")).toHaveText(game.app);

  // Back in the project, the game starts with the song's own folder, exported in Tune Studio's data.
  await page.getByTestId("rail-recent").click();
  await page.getByTestId("recent-item").click();
  await expect(page.getByTestId("project")).toBeVisible();
  await page.getByTestId("export-song").click();
  await page.getByRole("menuitem", { name: /Try in Tune Perfect/ }).click();
  await expect(page.getByText("Opened in Tune Perfect")).toBeVisible();
  await expect.poll(() => fs.existsSync(game.argv)).toBe(true);
  const [option, folder, electron] = fs.readFileSync(game.argv, "utf8").trimEnd().split("\n");
  expect(option).toBe("--songpath");
  // The app's own environment isn't the game's.
  expect(electron).toBe("electron:");
  expect(path.basename(folder!)).toBe("Test Artist - Night Signals");
  expect(path.basename(path.dirname(folder!))).toBe("try-in-game");
  expect(fs.readdirSync(folder!).toSorted()).toEqual([
    "Test Artist - Night Signals [CO].png",
    "Test Artist - Night Signals [INSTR].mp3",
    "Test Artist - Night Signals [VOC].mp3",
    "Test Artist - Night Signals.mp3",
    "Test Artist - Night Signals.txt",
  ]);
  // The audio as it is, never converted.
  expect(fs.readFileSync(path.join(folder!, "Test Artist - Night Signals.mp3")).equals(song.audio)).toBe(true);
  expect(studio.problems).toEqual([]);
});
