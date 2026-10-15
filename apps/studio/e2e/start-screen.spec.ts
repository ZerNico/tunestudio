import { expect, test } from "@playwright/test";

import { launchStudio, resize, type Studio } from "./app.ts";

let studio: Studio;

test.beforeEach(async () => {
  studio = await launchStudio({ width: 1280, height: 820 });
});

test.afterEach(async () => {
  await studio.close();
});

test("opens the start screen from the app:// build without console problems", async () => {
  const { page } = studio;
  expect(page.url()).toBe("app://tunestudio/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome to Tune Studio");
  for (const option of ["youtube", "audio", "song"]) await expect(page.getByTestId(`start-${option}`)).toBeVisible();
  // A fresh data directory: the first-launch state.
  await expect(page.getByTestId("recent-empty")).toBeVisible();
  await expect(page.getByTestId("open-project")).toBeVisible();
  await page.waitForTimeout(500);
  expect(studio.problems).toEqual([]);
});

test("keyboard navigation reaches the three start options", async () => {
  const { page } = studio;
  const wanted = new Set(["youtube-url", "audio-choose", "song-choose"]);
  const reached: string[] = [];
  for (let press = 0; press < 25 && reached.length < wanted.size; press++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
    if (wanted.has(id) && !reached.includes(id)) reached.push(id);
  }
  expect(reached).toEqual(["youtube-url", "audio-choose", "song-choose"]);
});

test("a pasted YouTube link opens the stub flow", async () => {
  const { page } = studio;
  await page.getByTestId("youtube-url").click();
  await page.keyboard.type("youtu.be/dQw4w9WgXcQ");
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("flow-dialog");
  await expect(dialog).toBeVisible();
  // The download tools come first. Tests run offline, so getting them fails with a way to try
  // again, and the flow doesn't go on to the video.
  await expect(dialog.getByTestId("tools-error")).toContainText("Couldn't check for yt-dlp");
  await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(dialog.getByTestId("not-implemented")).toBeHidden();
  // Closing a new project asks first.
  await page.keyboard.press("Escape");
  const discard = page.getByTestId("discard-dialog");
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Discard" }).click();
  await expect(dialog).toBeHidden();
  expect(studio.problems).toEqual([]);
});

test("the rail follows the scroll position, and clicking it scrolls", async () => {
  const { page } = studio;
  await resize(studio, 960, 640);
  const scroller = page.getByTestId("home-scroller");
  const home = page.getByTestId("rail-home");
  const recent = page.getByTestId("rail-recent");
  await expect(home).toHaveAttribute("aria-current", "page");

  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(recent).toHaveAttribute("aria-current", "page");
  await expect(home).not.toHaveAttribute("aria-current");

  await scroller.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(home).toHaveAttribute("aria-current", "page");

  await recent.click();
  await expect(recent).toHaveAttribute("aria-current", "page");
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await home.click();
  await expect(home).toHaveAttribute("aria-current", "page");
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
  expect(studio.problems).toEqual([]);
});
