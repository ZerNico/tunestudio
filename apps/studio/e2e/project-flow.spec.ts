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
  await expect(dialog.getByTestId("song-file")).toHaveCount(4);
  // Song, then Finish.
  await dialog.getByTestId("flow-next").click();
  await dialog.getByRole("button", { name: "Create project" }).click();

  // The project opens in the editor: every note in view, each line's text, the transport.
  await expect(page.getByTestId("project")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Night Signals");
  await expect(page.getByTestId("roll-note")).toHaveCount(5);
  await expect(page.getByTestId("lyrics-line")).toHaveCount(2);
  await expect(page.getByTestId("transport")).toBeVisible();
  // Nothing edited yet: nothing to undo or redo.
  await expect(page.getByTestId("undo")).toBeDisabled();
  await expect(page.getByTestId("redo")).toBeDisabled();
  // Zoomed all the way out with the playhead at the very end, nothing pokes out of the window (scrollbars would make
  // the view resize back and forth).
  for (let i = 0; i < 8; i++) await page.getByRole("button", { name: "Zoom out" }).click();
  const ruler = page.getByTestId("time-ruler");
  const box = (await ruler.boundingBox())!;
  await page.mouse.click(box.x + box.width - 1, box.y + box.height / 2);
  await expect(page.getByTestId("playhead")).toBeVisible();
  expect(
    await page.evaluate(() => {
      const root = document.scrollingElement!;
      return root.scrollWidth - root.clientWidth + (root.scrollHeight - root.clientHeight);
    }),
  ).toBe(0);

  await expect(page.getByTestId("roll-note")).toHaveCount(5);
  // The song's details (with its cover, and the headers it came with) are in a dialog from its name in the title bar.
  await page.getByTestId("open-song-details").click();
  const details = page.getByTestId("song-details");
  await expect(details.getByTestId("song-artist")).toHaveValue("Test Artist");
  await expect(details.getByText("#X-CUSTOM")).toBeVisible();
  // The cover comes through media:// (the CSP allows it) and decodes.
  const cover = details.getByTestId("file-cover").locator("img");
  await expect.poll(() => cover.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64);
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  expect(fs.existsSync(projectFile)).toBe(true);

  // Export, then export again: the folder exists, so it asks before replacing.
  const exports = path.join(song.dir, "Exports");
  fs.mkdirSync(exports);
  await answerDialogs(app, exports);
  await page.getByTestId("export-song").click();
  await page.getByTestId("export-folder").click();
  await expect(page.getByText("Exported for games")).toBeVisible();
  const exported = path.join(exports, "Test Artist - Night Signals");
  expect(fs.readdirSync(exported).toSorted()).toEqual([
    "Test Artist - Night Signals [CO].png",
    "Test Artist - Night Signals [INSTR].mp3",
    "Test Artist - Night Signals [VOC].mp3",
    "Test Artist - Night Signals.mp3",
    "Test Artist - Night Signals.txt",
  ]);
  expect(fs.readFileSync(path.join(exported, "Test Artist - Night Signals.mp3")).equals(song.audio)).toBe(true);
  const chart = fs.readFileSync(path.join(exported, "Test Artist - Night Signals.txt"), "utf8");
  expect(chart).toContain("#VERSION:1.2.0\n#TITLE:Night Signals\n#ARTIST:Test Artist\n");
  expect(chart).toContain("#X-CUSTOM:kept\n: 0 4 2 Hel\n");

  await answerDialogs(app, exports);
  await page.getByTestId("export-song").click();
  await page.getByTestId("export-folder").click();
  const replace = page.getByTestId("replace-export");
  await expect(replace).toBeVisible();
  await replace.getByTestId("confirm-replace").click();
  await expect(replace).toBeHidden();
  await expect(page.getByText("Exported for games")).toHaveCount(2);

  // The song's YouTube video goes in Song details; the text for USDB names it for usdb_syncer.
  await page.getByTestId("open-song-details").click();
  await page.getByTestId("song-youtube").fill("https://youtu.be/dQw4w9WgXcQ");
  await page.getByTestId("song-youtube").press("Enter");
  await expect(page.getByTestId("song-youtube")).toHaveValue("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.keyboard.press("Escape");
  const usdb = path.join(exports, "For USDB.txt");
  await answerDialogs(app, usdb);
  await page.getByTestId("export-song").click();
  await page.getByTestId("export-usdb").click();
  await expect(page.getByText("Exported for USDB")).toBeVisible();
  const text = fs.readFileSync(usdb, "utf8");
  expect(text).toContain("#ARTIST:Test Artist\r\n#TITLE:Night Signals\r\n#MP3:Test Artist - Night Signals.mp3\r\n");
  expect(text).toContain("#VIDEO:v=dQw4w9WgXcQ\r\n");
  expect(text).not.toContain("#VERSION");

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

test("imports both YouTube sources from a sidecar, edits them and keeps them when reopened", async () => {
  const { app, page } = studio;
  fs.writeFileSync(
    path.join(song.folder, "syncer.usdb"),
    JSON.stringify({
      version: 1,
      txt: { fname: "song.txt" },
      meta_tags: "a=dQw4w9WgXcQ,v=kPBzTxZQG5Q,co=cover.jpg",
      audio: { resource: "dQw4w9WgXcQ" },
      video: { resource: "kPBzTxZQG5Q" },
    }),
  );
  const project = path.join(song.dir, "Sources.tunestudio");
  await answerDialogs(app, song.folder, project);
  await page.getByTestId("song-choose").click();
  await page.getByTestId("flow-next").click();
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("project")).toBeVisible();
  await page.getByTestId("open-song-details").click();
  const video = page.getByRole("textbox", { name: "YouTube video" });
  const audio = page.getByRole("textbox", { name: "YouTube audio" });
  await expect(video).toHaveValue("https://www.youtube.com/watch?v=kPBzTxZQG5Q");
  await expect(audio).toHaveValue("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.getByTestId("song-details").screenshot({ path: test.info().outputPath("youtube-sources.png") });
  // A bare ID is stored, and rendered as a clean URL.
  await audio.fill("rl0IjlamWPI");
  await audio.press("Enter");
  await expect(audio).toHaveValue("https://www.youtube.com/watch?v=rl0IjlamWPI");
  await page.keyboard.press("Escape");
  await page.getByTestId("undo").click();
  await page.getByTestId("open-song-details").click();
  await expect(audio).toHaveValue("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await page.keyboard.press("Escape");
  await page.getByTestId("redo").click();
  await page.getByTestId("close-project").click();
  await expect(page.getByTestId("home")).toBeVisible();
  await page.getByTestId("recent-item").click();
  await expect(page.getByTestId("project")).toBeVisible();
  await page.getByTestId("open-song-details").click();
  await expect(video).toHaveValue("https://www.youtube.com/watch?v=kPBzTxZQG5Q");
  await expect(audio).toHaveValue("https://www.youtube.com/watch?v=rl0IjlamWPI");
  await page.keyboard.press("Escape");
  const exported = path.join(song.dir, "Sources.txt");
  await answerDialogs(app, exported);
  await page.getByTestId("export-song").click();
  await page.getByTestId("export-usdb").click();
  await expect(page.getByText("Exported for USDB")).toBeVisible();
  expect(fs.readFileSync(exported, "utf8")).toContain("#VIDEO:a=rl0IjlamWPI,v=kPBzTxZQG5Q,co=cover.jpg\r\n");
  expect(studio.problems).toEqual([]);
});

test("opens a project with Open project, and drops a missing one from recents", async () => {
  const { app, page } = studio;
  const projectFile = path.join(song.dir, "Night Signals.tunestudio");
  await answerDialogs(app, song.folder, projectFile);
  await page.getByTestId("song-choose").click();
  // Song, then Finish.
  await page.getByTestId("flow-next").click();
  await page.getByRole("button", { name: "Create project" }).click();
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
  await expect(dialog.getByTestId("flow-next")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(studio.problems).toEqual([]);
});
