import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { launchStudio, type Studio } from "./app.ts";
import { answerDialogs, revealedPaths, type SongFixture, songFixture, stubDesktop } from "./fixtures.ts";

let studio: Studio;
let song: SongFixture;

test.beforeEach(async () => {
  song = songFixture();
  studio = await launchStudio({ width: 1280, height: 820 });
  await stubDesktop(studio.app);
});

test.afterEach(async () => {
  await studio.close();
  song.cleanup();
});

test("imports a song folder, exports it, and reopens the project from recents", async () => {
  const { app, page } = studio;
  const projectFile = path.join(song.dir, "Projects", "Night Signals.tunestudio");
  fs.mkdirSync(path.dirname(projectFile));

  // Import: pick the folder, check what was found, choose where to save.
  await answerDialogs(app, song.folder, projectFile);
  await page.getByTestId("song-choose").click();
  const dialog = page.getByTestId("flow-dialog");
  await expect(dialog.getByTestId("song-title")).toHaveText("Test Artist · Night Signals");
  await expect(dialog.getByTestId("song-file")).toHaveCount(2);
  await dialog.getByTestId("song-create").click();

  // The project screen.
  await expect(page.getByTestId("project")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Night Signals");
  await expect(page.getByTestId("project-artist")).toHaveText("Test Artist");
  await expect(page.getByTestId("stat-notes")).toHaveText("5");
  await expect(page.getByTestId("stat-lines")).toHaveText("2");
  await expect(page.getByTestId("media-row")).toHaveCount(2);
  await expect(page.getByText("#X-CUSTOM")).toBeVisible();
  expect(fs.existsSync(projectFile)).toBe(true);
  // The cover comes through media:// (the CSP allows it) and decodes.
  const cover = page.locator('[data-slot="project-cover"] img');
  await expect.poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64);
  await expect(page.getByTestId("audio-preview")).toBeVisible();

  // Export, then export again: the folder exists, so it asks before replacing.
  const exports = path.join(song.dir, "Exports");
  fs.mkdirSync(exports);
  await answerDialogs(app, exports);
  await page.getByTestId("export-song").click();
  await expect(page.getByText("Exported the UltraStar song")).toBeVisible();
  const exported = path.join(exports, "Test Artist - Night Signals");
  expect(fs.readdirSync(exported).toSorted()).toEqual([
    "Test Artist - Night Signals [CO].png",
    "Test Artist - Night Signals.mp3",
    "Test Artist - Night Signals.txt",
  ]);
  expect(fs.readFileSync(path.join(exported, "Test Artist - Night Signals.mp3")).equals(song.audio)).toBe(true);
  const chart = fs.readFileSync(path.join(exported, "Test Artist - Night Signals.txt"), "utf8");
  expect(chart).toContain("#VERSION:1.2.0\n#TITLE:Night Signals\n#ARTIST:Test Artist\n");
  expect(chart).toContain("#X-CUSTOM:kept\n: 0 4 2 Hel\n");

  await answerDialogs(app, exports);
  await page.getByTestId("export-song").click();
  const replace = page.getByTestId("replace-export");
  await expect(replace).toBeVisible();
  await replace.getByTestId("confirm-replace").click();
  await expect(replace).toBeHidden();
  await expect(page.getByText("Exported the UltraStar song")).toHaveCount(2);

  // Close, and the project is in recents with its cover thumbnail.
  await page.getByTestId("close-project").click();
  await expect(page.getByTestId("home")).toBeVisible();
  const item = page.getByTestId("recent-item");
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAccessibleName(/^Test Artist, Night Signals\. Opened just now\.$/);
  await expect(item.locator("img")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);

  // Reveal in Finder, remove with undo, and reopen.
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Reveal in Finder|Show in/ }).click();
  await expect.poll(() => revealedPaths(app)).toEqual([projectFile]);
  await item.focus();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("recent-item")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("recent-item")).toHaveCount(1);
  await page.getByTestId("recent-item").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Night Signals");
  expect(studio.problems).toEqual([]);
});

test("opens a project with Open project…, and drops a missing one from recents", async () => {
  const { app, page } = studio;
  const projectFile = path.join(song.dir, "Night Signals.tunestudio");
  await answerDialogs(app, song.folder, projectFile);
  await page.getByTestId("song-choose").click();
  await page.getByTestId("song-create").click();
  await expect(page.getByTestId("project")).toBeVisible();
  await page.getByTestId("close-project").click();

  await answerDialogs(app, projectFile);
  await page.getByTestId("open-project").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Night Signals");
  await page.getByTestId("close-project").click();

  await expect(page.getByTestId("home")).toBeVisible();
  fs.rmSync(projectFile);
  await page.reload();
  await expect(page.getByTestId("recent-empty")).toBeVisible();
  expect(studio.problems).toEqual([]);
});

test("explains a song folder without its audio and creates nothing", async () => {
  const { app, page } = studio;
  fs.rmSync(path.join(song.folder, "song.mp3"));
  await answerDialogs(app, song.folder);
  await page.getByTestId("song-choose").click();
  const dialog = page.getByTestId("flow-dialog");
  await expect(dialog.getByTestId("song-blocker")).toHaveText(
    "The audio file “song.mp3” is missing from the song folder.",
  );
  await expect(dialog.getByTestId("song-create")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(studio.problems).toEqual([]);
});
