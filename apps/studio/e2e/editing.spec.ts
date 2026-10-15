import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { launchStudio, type Studio } from "./app.ts";
import { answerDialogs, type SongFixture, songFixture, stubDesktop } from "./fixtures.ts";

let studio: Studio;
let song: SongFixture;
/** The system clipboard's text from before: copying in the test writes the real one. */
let saved = "";

test.beforeEach(async () => {
  song = songFixture();
  studio = await launchStudio({ width: 1280, height: 820 });
  await stubDesktop(studio.app);
  saved = await studio.app.evaluate(({ clipboard }) => clipboard.readText());
});

test.afterEach(async () => {
  await studio.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved);
  await studio.close();
  song.cleanup();
});

/** Imports the fixture song and opens it in the editor. */
async function openSong() {
  const { app, page } = studio;
  const projectFile = path.join(song.dir, "Projects", "Night Signals.tunestudio");
  fs.mkdirSync(path.dirname(projectFile));
  await answerDialogs(app, song.folder, projectFile);
  await page.getByTestId("song-choose").click();
  await page.getByTestId("flow-dialog").getByTestId("song-create").click();
  await expect(page.getByTestId("roll-note")).toHaveCount(5);
}

/** Moves the playhead to `fraction` of the time ruler. */
async function seekTo(fraction: number) {
  const box = (await studio.page.getByTestId("time-ruler").boundingBox())!;
  await studio.page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
}

/** Runs one of the Edit menu's items (Copy, Paste), as a click on it would. */
async function menuItem(label: "Copy" | "Paste") {
  await studio.app.evaluate(({ BrowserWindow, Menu }, wanted) => {
    const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === "Edit");
    const item = edit?.submenu?.items.find((entry) => entry.label === wanted);
    // As a click does: Electron passes the window it is for (the tests' window is never focused).
    const window = BrowserWindow.getAllWindows()[0];
    item?.click(undefined, window, window?.webContents);
  }, label);
}

test("copies and pastes notes with the keys and the Edit menu, undone in one step", async () => {
  await openSong();
  const { page } = studio;
  const notes = page.getByTestId("roll-note");

  // Keys: the first two notes, pasted near the end.
  await notes.nth(0).click();
  await notes.nth(1).click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+c");
  await seekTo(0.8);
  await page.keyboard.press("ControlOrMeta+v");
  await expect(notes).toHaveCount(7);
  await expect(page.getByTestId("undo")).toHaveAttribute("aria-label", "Undo Paste 2 notes");
  // The lyrics went on the system clipboard as text.
  expect(await studio.app.evaluate(({ clipboard }) => clipboard.readText())).toBe("Hello");
  await page.getByTestId("undo").click();
  await expect(notes).toHaveCount(5);

  // The Edit menu (macOS): the same, through its Copy and Paste items.
  if (process.platform === "darwin") {
    await notes.nth(0).click();
    await menuItem("Copy");
    await seekTo(0.9);
    await menuItem("Paste");
    await expect(notes).toHaveCount(6);
    await expect(page.getByTestId("undo")).toHaveAttribute("aria-label", "Undo Paste note");
  }
});

test("scrubbing to the roll's edge scrolls the view, and the playhead goes on with it", async () => {
  await openSong();
  const { page } = studio;
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Zoom in" }).click();
  const ruler = page.getByTestId("time-ruler");
  const ticks = () => ruler.locator("span").allTextContents();
  const before = await ticks();
  const box = (await ruler.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Held just inside the right edge: the view scrolls on, the playhead with it.
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 8 });
  await expect.poll(async () => (await ticks())[0]).not.toBe(before[0]);
  await page.mouse.up();
  const time = await page.getByTestId("transport-time").textContent();
  // Past the last tick that was in view before.
  expect(time!.split("/")[0]!.trim() > before.at(-1)!).toBe(true);
});
