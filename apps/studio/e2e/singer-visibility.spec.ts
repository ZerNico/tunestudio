import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { launchStudio, type Studio } from "./app.ts";
import { answerDialogs, type SongFixture, songFixture, stubDesktop } from "./fixtures.ts";

let studio: Studio;
let song: SongFixture;

test.beforeEach(async () => {
  song = songFixture();
  studio = await launchStudio({ width: 1280, height: 820 });
  await stubDesktop(studio.app);
  const projectFile = path.join(song.dir, "Projects", "Night Signals.tunestudio");
  fs.mkdirSync(path.dirname(projectFile));
  await answerDialogs(studio.app, song.folder, projectFile);
  await studio.page.getByTestId("song-choose").click();
  await studio.page.getByTestId("flow-dialog").getByTestId("flow-next").click();
  await studio.page.getByTestId("flow-dialog").getByRole("button", { name: "Create project" }).click();
  await expect(studio.page.getByTestId("roll-note")).toHaveCount(5);
  await studio.page.getByRole("button", { name: "Add singer", exact: true }).click();
  await studio.page.getByRole("textbox", { name: "Name of P2" }).press("Escape");
});

test.afterEach(async () => {
  await studio.close();
  song.cleanup();
});

test("hiding the singer with the last notes leaves timeline length and seeking unchanged", async () => {
  const { page } = studio;
  const notes = page.getByTestId("roll-note");
  // The synthetic audio doesn't decode, so chart notes determine the timeline's length.
  await notes.nth(3).click();
  await notes.nth(4).click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Sung by P2" }).click();
  await expect(notes.and(page.locator('[data-singer="2"]'))).toHaveCount(2);
  const time = page.getByTestId("transport-time");
  await expect(time).toContainText(" / 0:04");
  const duration = (await time.textContent())!.split(" / ")[1]!;

  await page.getByRole("button", { name: "Hide P2", exact: true }).click();
  await expect(notes).toHaveCount(3);
  await expect(time).toContainText(` / ${duration}`);
  const ruler = (await page.getByTestId("ruler-area").boundingBox())!;
  const end = (await page.getByTestId("marker-end").boundingBox())!;
  // Seek near the song's end, beyond the duration that P1 alone would give the timeline.
  await page.mouse.click(ruler.x + (end.x + end.width - ruler.x) * 0.9, ruler.y + ruler.height / 2);
  await expect(time).toContainText("0:03.7");
  await page.getByRole("button", { name: "Show P2", exact: true }).click();
  await expect(notes).toHaveCount(5);
  await expect(time).toContainText(` / ${duration}`);
});

test("game export shows the warning when an empty singer is omitted", async () => {
  const { app, page } = studio;
  const folder = path.join(song.dir, "Exports");
  fs.mkdirSync(folder);
  await answerDialogs(app, folder);
  await page.getByTestId("export-song").click();
  await page.getByTestId("export-folder").click();
  await expect(page.getByText("Exported for games")).toBeVisible();
  await expect(
    page.getByText("P2 has no notes, so the song is exported as a solo chart.", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("export-warning.png"), animations: "disabled" });
  const chart = fs.readFileSync(
    path.join(folder, "Test Artist - Night Signals", "Test Artist - Night Signals.txt"),
    "utf8",
  );
  expect(chart).not.toMatch(/^P[12]$/m);
  expect(chart).not.toContain("#P2:");
});
