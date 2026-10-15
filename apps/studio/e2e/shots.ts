/**
 * Screenshots of the start screen, the song import and the project screen, for design review:
 *   node e2e/shots.ts [prod|dev]   (prod: run `bun run build` first; dev: starts Vite itself)
 * Images land in `<repo>/.local/shots/<mode>/` (gitignored). Runs under Node, since
 * Playwright's Electron driver doesn't connect under Bun. Dialogs are stubbed; nothing shows.
 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DEV_SERVER_PORT } from "../scripts/dev-port.ts";
import { appDir, launchStudio, resize, type Studio } from "./app.ts";
import { answerDialogs, songFixture, stubDesktop } from "./fixtures.ts";

const mode = process.argv[2] === "dev" ? "dev" : "prod";
const outDir = path.resolve(appDir, "../../.local/shots", mode);
fs.mkdirSync(outDir, { recursive: true });

async function startVite(): Promise<{ url: string; process: ChildProcess }> {
  const url = `http://localhost:${DEV_SERVER_PORT}`;
  const vite = spawn("bunx", ["vite"], { cwd: appDir, stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(url);
      return { url, process: vite };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  vite.kill();
  throw new Error("Vite didn't start");
}

async function shot(studio: Studio, name: string) {
  await studio.page.waitForTimeout(350);
  await studio.page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`  ${name}.png`);
}

async function closeDialog(studio: Studio) {
  await studio.page.keyboard.press("Escape");
  // New projects ask before their setup is thrown away.
  const discard = studio.page.getByTestId("discard-dialog");
  const asked = await discard.waitFor({ timeout: 1000 }).then(
    () => true,
    () => false,
  );
  if (asked) await discard.getByRole("button", { name: "Discard" }).click();
  await studio.page.getByRole("dialog").first().waitFor({ state: "detached" });
}

const vite = mode === "dev" ? await startVite() : null;
const song = songFixture();
const audio = path.join(song.dir, "Raum27 - Oft gesagt.mp3");
fs.writeFileSync(audio, Buffer.alloc(4_718_592));
const studio = await launchStudio({ devServerUrl: vite?.url, width: 1440, height: 900 });
const { app, page } = studio;
await stubDesktop(app);

try {
  await page.evaluate(() => localStorage.removeItem("tunestudio.home.recentView"));
  await page.reload();
  await page.getByTestId("home").waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await shot(studio, "01-home-empty-1440x900");

  await answerDialogs(app, song.folder);
  await page.getByTestId("song-choose").click();
  await page.getByTestId("song-title").waitFor();
  await shot(studio, "02-import-song");
  await closeDialog(studio);

  // A few projects for the recents list, each imported through the real flow.
  for (const name of ["Night Signals", "Second Song", "Third Song"]) {
    const chart = path.join(song.folder, "song.txt");
    fs.writeFileSync(chart, fs.readFileSync(chart, "utf8").replace(/#TITLE:.*/, `#TITLE:${name}`));
    await answerDialogs(app, song.folder, path.join(song.dir, `${name}.tunestudio`));
    await page.getByTestId("song-choose").click();
    await page.getByTestId("song-create").click();
    await page.getByTestId("project").waitFor();
    if (name === "Night Signals") {
      await page.mouse.move(0, 0);
      await shot(studio, "03-project-1440x900");
      await page.getByTestId("export-song").waitFor();
    }
    await page.getByTestId("close-project").click();
    await page.getByTestId("home").waitFor();
  }

  await page.getByTestId("recent-item").first().waitFor();
  await shot(studio, "04-home-grid-1440x900");
  await page
    .getByRole("radio", { name: "List" })
    .or(page.getByRole("button", { name: "List" }))
    .click();
  await page.mouse.move(0, 0);
  await shot(studio, "05-home-list-1440x900");
  await page.getByTestId("rail-settings").click();
  await page.getByTestId("settings-models").scrollIntoViewIfNeeded();
  await shot(studio, "13-settings-models-1440x900");
  await page.getByTestId("rail-home").click();
  await page.getByTestId("home").waitFor();
  await page
    .getByRole("radio", { name: "Grid" })
    .or(page.getByRole("button", { name: "Grid" }))
    .click();

  await page.getByTestId("recent-item").nth(1).click({ button: "right" });
  await page.getByTestId("project-menu").waitFor();
  await shot(studio, "06-context-menu");
  await page.keyboard.press("Escape");

  await page.getByTestId("recent-search").fill("zzz");
  await shot(studio, "07-search-no-results");
  await page.getByTestId("recent-search").fill("");

  await page.getByTestId("audio-input").setInputFiles(audio);
  await page.getByTestId("flow-dialog").waitFor();
  await shot(studio, "08-flow-audio");
  await closeDialog(studio);

  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(["x"], "song.mp3", { type: "audio/mpeg" }));
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, bubbles: true }));
  });
  await page.getByTestId("drop-overlay").waitFor();
  await shot(studio, "09-drop-overlay");
  await page.evaluate(() => window.dispatchEvent(new DragEvent("drop", { dataTransfer: new DataTransfer() })));

  await resize(studio, 1024, 700);
  await shot(studio, "10-home-grid-1024x700");
  await page.getByTestId("recent-item").first().click();
  await page.getByTestId("project").waitFor();
  await shot(studio, "11-project-1024x700");
  await resize(studio, 960, 640);
  await shot(studio, "12-project-min-960x640");

  // Dev builds of Solid 2 print reactivity diagnostics as warnings (base-ui-solid triggers a
  // few, see AGENTS.md); only errors fail the run.
  for (const problem of studio.problems) console.log(problem.split("\n")[0]);
  if (studio.problems.some((problem) => !problem.startsWith("warning:"))) process.exitCode = 1;
} finally {
  await studio.close();
  vite?.process.kill();
  song.cleanup();
}
