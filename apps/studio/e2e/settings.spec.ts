import { expect, test } from "@playwright/test";

import { launchStudio, type Studio } from "./app.ts";

let studio: Studio;

test.beforeEach(async () => {
  studio = await launchStudio({ width: 1280, height: 820 });
});

test.afterEach(async () => {
  await studio.close();
});

test("settings are saved right away and kept", async () => {
  const { page } = studio;
  await page.getByTestId("rail-settings").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(page.getByTestId("rail-settings")).toHaveAttribute("aria-current", "page");

  // USDB Syncer's defaults.
  await expect(page.getByTestId("audio-format")).toHaveText("M4A (AAC)");
  await expect(page.getByTestId("audio-bitrate")).toHaveText("256 kbps");
  await expect(page.getByTestId("video-resolution")).toHaveText("1080p");

  await page.getByTestId("audio-format").click();
  await page.getByRole("option", { name: "Opus" }).click();
  await expect(page.getByTestId("audio-format")).toHaveText("Opus");

  // Without the video, its options don't apply.
  await page.getByTestId("video-download").click();
  await expect(page.getByTestId("video-format")).toBeDisabled();

  await page.reload();
  await expect(page.getByTestId("audio-format")).toHaveText("Opus");
  await expect(page.getByTestId("video-download")).not.toBeChecked();
  await expect(page.getByTestId("video-format")).toBeDisabled();

  // Home and Recent lead back to the start screen.
  await page.getByTestId("rail-recent").click();
  await expect(page.getByTestId("home")).toBeVisible();
  await expect(page.getByTestId("rail-recent")).toHaveAttribute("aria-current", "page");
  expect(studio.problems).toEqual([]);
});

test("the download tools show what is installed; checking offline explains the failure", async () => {
  const { page } = studio;
  await page.getByTestId("rail-settings").click();
  await expect(page.getByTestId("tool-yt-dlp")).toContainText("Not installed");
  await page.getByTestId("tools-check").click();
  await expect(page.getByText("Couldn't update the download tools")).toBeVisible();
  await expect(page.getByTestId("tools-check")).toBeEnabled();
});
