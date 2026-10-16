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
      // Editing: one note lengthened into the next (an overlap).
      const notes = page.getByTestId("roll-note");
      await notes.nth(1).click();
      for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowRight");
      // A golden and a rap note, then a range selected.
      await notes.nth(3).click();
      await page.keyboard.press("g");
      await notes.nth(4).click();
      await page.keyboard.press("r");
      await notes.nth(1).click();
      await page.keyboard.press("f");
      await notes.nth(0).click();
      await notes.nth(4).click({ modifiers: ["ControlOrMeta"] });
      await page.mouse.move(0, 0);
      await shot(studio, "03b-project-editing");
      // Undo from the title bar puts the freestyle note back, Redo makes it freestyle again.
      await page.getByTestId("undo").click();
      if ((await notes.nth(1).getAttribute("data-type")) === "freestyle") throw new Error("Undo didn't undo");
      await page.getByTestId("redo").click();
      // Halfway through dragging "good" right and up: the preview and its label.
      const box = (await notes.nth(3).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 - 70, { steps: 5 });
      await shot(studio, "03c-project-dragging");
      await page.mouse.up();
      // The Split tool over "bye": the cut line where a click would split it.
      await page.keyboard.press("c");
      const bye = (await notes.nth(4).boundingBox())!;
      await page.mouse.move(bye.x + bye.width * 0.4, bye.y + bye.height / 2);
      await shot(studio, "03d-project-split-tool");
      // The Draw tool: a new note drawn, its syllable being typed.
      await page.keyboard.press("d");
      await page.mouse.move(bye.x - 260, bye.y - 40);
      await page.mouse.down();
      await page.mouse.move(bye.x - 140, bye.y - 40, { steps: 4 });
      await page.mouse.up();
      await page.keyboard.type("new");
      await shot(studio, "03e-project-draw-tool");
      await page.keyboard.press("Enter");
      await page.keyboard.press("v");
      // Dragging the line break left across "world": the preview and how many notes move.
      const marker = (await page.getByTestId("break-marker").first().boundingBox())!;
      await page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
      await page.mouse.down();
      await page.mouse.move(marker.x - 240, marker.y + marker.height / 2, { steps: 6 });
      await shot(studio, "03f-project-break-drag");
      await page.mouse.up();
      // A selection of notes and the line break (Shift on its marker): drawn solid in the selection's colour.
      await notes.nth(2).click();
      await notes.nth(4).click({ modifiers: ["Shift"] });
      await page
        .getByTestId("break-marker")
        .first()
        .click({ modifiers: ["Shift"] });
      await page.mouse.move(0, 0);
      await shot(studio, "03o-break-selection");
      await page.keyboard.press("Escape");
      await page.getByTestId("export-song").click();
      await page.getByTestId("export-menu").waitFor();
      await shot(studio, "03p-export-menu");
      await page.keyboard.press("Escape");
      // Toasts: one line (a split with the playhead outside notes), and with a description (auto pitch without vocals).
      await page.keyboard.press("Meta+k");
      await shot(studio, "03g-toast");
      await page.getByTestId("roll-note").first().click();
      await page.keyboard.press("a");
      await page.locator('[data-slot="toast"][data-type="error"]').waitFor();
      await shot(studio, "03h-toast-error");
      // The note menu on a selected note, and the auto pitch button next to the tools.
      await page.getByTestId("roll-note").nth(1).click({ button: "right" });
      await page.getByTestId("note-menu").waitFor();
      await shot(studio, "03i-note-menu");
      await page.keyboard.press("Escape");
      // A loop range marked on the ruler, and the transport's loop, speed, follow and tones controls.
      const ruler = (await page.getByTestId("time-ruler").boundingBox())!;
      await page.mouse.move(ruler.x + ruler.width * 0.25, ruler.y + ruler.height / 2);
      await page.mouse.down();
      await page.mouse.move(ruler.x + ruler.width * 0.55, ruler.y + ruler.height / 2, { steps: 5 });
      await page.mouse.up();
      await page.getByTestId("tones").click();
      await shot(studio, "03j-loop-transport");
      await page.getByTestId("tones").click();
      await page.getByTestId("tones").click();
      await shot(studio, "03n-transport");
      await page.getByTestId("tones").click();
      // The song details dialog, from the song's name in the title bar.
      await page.getByTestId("open-song-details").click();
      await page.getByTestId("song-details").waitFor();
      await shot(studio, "03k-song-details");
      await page.getByTestId("file-cover").getByRole("button", { name: "Change" }).click();
      await page.getByTestId("cover-dialog").waitFor();
      await shot(studio, "03m-cover-dialog");
      await page.keyboard.press("Escape");
      await page.getByTestId("cover-dialog").waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await page.getByTestId("song-details").waitFor({ state: "hidden" });
      // Start, preview and medley set, the end dragged in: the markers on the ruler and the overview bar.
      const notesInRoll = page.getByTestId("roll-note");
      await notesInRoll.nth(0).click();
      await notesInRoll.nth(2).click({ modifiers: ["Shift"] });
      const rulerBox = (await page.getByTestId("time-ruler").boundingBox())!;
      await page.mouse.click(rulerBox.x + rulerBox.width * 0.12, rulerBox.y + rulerBox.height / 2);
      await page.getByTestId("open-song-details").click();
      const timing = page.getByTestId("song-timing");
      await timing.getByTestId("timing-start").getByRole("button", { name: "Playhead" }).click();
      await page.mouse.click(rulerBox.x + rulerBox.width * 0.3, rulerBox.y + rulerBox.height / 2).catch(() => {});
      await timing.getByTestId("timing-preview").getByRole("button", { name: "Playhead" }).click();
      await timing.getByTestId("timing-medley").getByRole("button", { name: "Selected lines" }).click();
      await page.keyboard.press("Escape");
      await page.getByTestId("song-details").waitFor({ state: "hidden" });
      const endBox = (await page.getByTestId("marker-end").boundingBox())!;
      await page.mouse.move(endBox.x + endBox.width / 2, endBox.y + endBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(endBox.x - 260, endBox.y + endBox.height / 2, { steps: 5 });
      await page.mouse.up();
      await shot(studio, "03l-song-markers");
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
