import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { launchStudio, type Studio } from "./app.ts";
import { answerDialogs, type SongFixture, songFixture, stubDesktop } from "./fixtures.ts";

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

/** Imports the fixture song as a project at `file`, then closes it again. */
async function importAs(page: Page, file: string) {
  await answerDialogs(studio.app, song.folder, file);
  await page.getByTestId("song-choose").click();
  await page.getByTestId("flow-dialog").getByTestId("song-create").click();
  await expect(page.getByTestId("project")).toBeVisible();
  await page.getByTestId("close-project").click();
  await expect(page.getByTestId("home")).toBeVisible();
}

/** What the OS does when a project file is double-clicked (macOS hands it over as an event). */
function openFromOs(file: string) {
  return studio.app.evaluate(({ app }, target) => {
    app.emit("open-file", { preventDefault: () => {} }, target);
  }, file);
}

test("project files from the OS open in the start screen's window, or in one of their own", async () => {
  const { app, page } = studio;
  const first = path.join(song.dir, "First.tunestudio");
  const second = path.join(song.dir, "Second.tunestudio");
  await importAs(page, first);
  await importAs(page, second);

  // The start screen's window opens it.
  await openFromOs(first);
  await expect(page.getByTestId("project")).toBeVisible();
  // Asked again, that window comes to the front: no other opens.
  await openFromOs(first);
  await page.waitForTimeout(300);
  expect(app.windows()).toHaveLength(1);

  // Another project gets a window of its own.
  const opened = app.waitForEvent("window");
  await openFromOs(second);
  const other = await opened;
  await expect(other.getByTestId("project")).toBeVisible();
  expect(app.windows()).toHaveLength(2);

  // Opening the first project from the second window's start screen brings its window back instead.
  await other.getByTestId("close-project").click();
  await expect(other.getByTestId("home")).toBeVisible();
  await answerDialogs(app, first);
  await other.getByRole("button", { name: "Open project" }).click();
  await page.waitForTimeout(300);
  await expect(other.getByTestId("home")).toBeVisible();
  await expect(page.getByTestId("project")).toBeVisible();
});

test("the mouse's back button doesn't leave the editor", async () => {
  const { page } = studio;
  const file = path.join(song.dir, "Project.tunestudio");
  await answerDialogs(studio.app, song.folder, file);
  await page.getByTestId("song-choose").click();
  await page.getByTestId("flow-dialog").getByTestId("song-create").click();
  await expect(page.getByTestId("project")).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: 400, y: 400, button: "back", buttons: 8, clickCount: 1 });
  }
  await page.waitForTimeout(300);
  await expect(page.getByTestId("project")).toBeVisible();
});
