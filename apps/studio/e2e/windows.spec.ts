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
  // Song, then Finish.
  await page.getByTestId("flow-dialog").getByTestId("flow-next").click();
  await page.getByTestId("flow-dialog").getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("project")).toBeVisible();
  await page.getByTestId("close-project").click();
  await expect(page.getByTestId("home")).toBeVisible();
}

/** Records which windows main brings to the front (`focused`), from now on. */
function watchFocus() {
  return studio.app.evaluate(({ BrowserWindow }) => {
    const state = Object.assign(globalThis, { focused: [] as number[] });
    const focus = BrowserWindow.prototype.focus;
    BrowserWindow.prototype.focus = function (this: Electron.BrowserWindow) {
      state.focused.push(this.id);
      return focus.call(this);
    };
  });
}

/** The ids of the windows brought to the front since the last call, in order. */
function focused() {
  return studio.app.evaluate(() => (globalThis as typeof globalThis & { focused: number[] }).focused.splice(0));
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
  const firstWindow = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.id),
  );
  expect(firstWindow).toHaveLength(1);
  await watchFocus();
  // Asked again, that window comes to the front (main's answer to the request, so it was handled): no other opens.
  await openFromOs(first);
  await expect.poll(focused).toEqual(firstWindow);
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
  await focused();
  await other.getByRole("button", { name: "Open project" }).click();
  // Main brings the first window to the front instead of opening the project in this one (`project.open`).
  await expect.poll(focused).toEqual(firstWindow);
  await expect(other.getByTestId("home")).toBeVisible();
  await expect(page.getByTestId("project")).toBeVisible();
});

test("the mouse's back button doesn't leave the editor", async () => {
  const { page } = studio;
  const file = path.join(song.dir, "Project.tunestudio");
  await answerDialogs(studio.app, song.folder, file);
  await page.getByTestId("song-choose").click();
  // Song, then Finish.
  await page.getByTestId("flow-dialog").getByTestId("flow-next").click();
  await page.getByTestId("flow-dialog").getByRole("button", { name: "Create project" }).click();
  await expect(page.getByTestId("project")).toBeVisible();
  // Chromium goes back on these unless the page prevents their default; the last listener sees whether it did.
  await page.evaluate(() => {
    const seen = Object.assign(window, { backButton: [] as string[] }).backButton;
    for (const type of ["mousedown", "mouseup"])
      window.addEventListener(type, (event) => {
        const { button, defaultPrevented } = event as MouseEvent;
        if (button === 3) seen.push(`${type}${defaultPrevented ? " prevented" : ""}`);
      });
  });
  const url = page.url();
  const cdp = await page.context().newCDPSession(page);
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await cdp.send("Input.dispatchMouseEvent", { type, x: 400, y: 400, button: "back", buttons: 8, clickCount: 1 });
  }
  await expect
    .poll(() => page.evaluate(() => (window as Window & { backButton?: string[] }).backButton))
    .toEqual(["mousedown prevented", "mouseup prevented"]);
  expect(page.url()).toBe(url);
  await expect(page.getByTestId("project")).toBeVisible();
});

test("the File menu's project items act on the project in front (macOS)", async () => {
  test.skip(process.platform !== "darwin", "Only macOS has a menu bar");
  const { app, page } = studio;
  await importAs(page, path.join(song.dir, "Project.tunestudio"));
  await openFromOs(path.join(song.dir, "Project.tunestudio"));
  await expect(page.getByTestId("project")).toBeVisible();
  const click = (id: string) =>
    app.evaluate(({ BrowserWindow, Menu }, item) => {
      const window = BrowserWindow.getAllWindows()[0];
      Menu.getApplicationMenu()
        ?.getMenuItemById(item)
        ?.click(undefined, window, undefined as never);
    }, id);
  await click("song-details");
  await expect(page.getByTestId("song-details")).toBeVisible();
  await page.keyboard.press("Escape");
  await click("close-project");
  await expect(page.getByTestId("home")).toBeVisible();
});
