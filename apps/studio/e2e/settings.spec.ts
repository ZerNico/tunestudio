import fs from "node:fs";

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

test("the models show what is downloaded; downloading offline explains the failure", async () => {
  const { page } = studio;
  await page.getByTestId("rail-settings").click();
  await expect(page.getByTestId("models-chart-status")).toContainText("Not downloaded");
  await expect(page.getByTestId("models-chart")).toContainText("CC BY-NC-SA 4.0");
  await expect(page.getByTestId("models-chart")).toContainText("v1.0.3");
  // Nothing installed, so nothing to remove.
  await expect(page.getByTestId("tool-yt-dlp-remove")).toHaveCount(0);
  await expect(page.getByTestId("models-chart-remove")).toHaveCount(0);
  await page.getByTestId("models-separation-download").click();
  await expect(page.getByText("Couldn't download the models")).toBeVisible();
  await expect(page.getByTestId("models-separation-download")).toBeEnabled();
  expect(studio.problems).toEqual([]);
});

test("About lists the app's license and the open source licenses from the build", async () => {
  const { app, page } = studio;
  // Opening Chromium's licenses would start the browser: record the file instead.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { opened });
    shell.openPath = async (file: string) => {
      opened.push(file);
      return "";
    };
  });
  await page.getByTestId("rail-settings").click();
  const about = page.getByRole("region", { name: "About" });
  await expect(about.getByTestId("about-version")).toHaveText(/^Version \d+\.\d+\.\d+/);

  await about.getByRole("button", { name: "Read the license" }).click();
  await expect(page.getByRole("dialog", { name: "MIT license" })).toContainText("Copyright (c) 2026 Nico Franke");
  await page.keyboard.press("Escape");

  await about.getByRole("button", { name: "Show licenses" }).click();
  const dialog = page.getByRole("dialog", { name: "Open source licenses" });
  const apps = dialog.getByRole("region", { name: /^App libraries/ });
  await expect(apps.getByRole("button", { name: /^solid-js/ })).toBeVisible();
  await expect(dialog.getByRole("region", { name: /^Native libraries/ })).toContainText("ONNX Runtime");

  const solid = apps.getByRole("button", { name: /^solid-js/ });
  await solid.click();
  await expect(solid).toHaveAttribute("aria-expanded", "true");
  await expect(apps.getByTestId("licenses-text")).toContainText("Ryan Carniato");

  await dialog.getByRole("searchbox", { name: "Search licenses" }).fill("whisper");
  await expect(dialog.getByRole("region", { name: /^App libraries/ })).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: /^Native libraries/ })).toContainText("whisper.cpp and ggml");
  await dialog.getByRole("searchbox", { name: "Search licenses" }).fill("");

  await dialog.getByRole("button", { name: "Open in browser" }).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as typeof globalThis & { opened: string[] }).opened))
    .toEqual([expect.stringMatching(/LICENSES\.chromium\.html$/)]);
  const [file] = await app.evaluate(() => (globalThis as typeof globalThis & { opened: string[] }).opened);
  expect(fs.existsSync(file!)).toBe(true);

  await dialog.getByRole("button", { name: "Show models" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("region", { name: "Models" })).toBeInViewport();
  expect(studio.problems).toEqual([]);
});
