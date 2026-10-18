/**
 * The README's screenshots, from a real chart the app makes itself:
 *   bun run shots:readme -- <audio file>   (or TUNESTUDIO_README_SONG=<audio file>; run `bun run build` first)
 *
 * The song is "Amazing Grace" (John Newton, 1779; the last verse from "Uncle Tom's Cabin", 1852), as sung by Southern
 * Aire of the United States Air Force Reserve Band (2002). The recording is a work of the US federal government, in the
 * public domain (PD-USGov-Military-Air Force):
 * https://commons.wikimedia.org/wiki/File:Amazing_Grace_(vocalist_with_guitar)_-_Southern_Aire_-_United_States_Air_Force_Reserve_Band.mp3
 * Download it yourself; it isn't committed. Commons' file has the album's artwork embedded, which the new-project
 * dialog would show; the README's shots used a copy without it, the audio stream copied as is:
 *   ffmpeg -i amazing-grace.mp3 -map 0:a -c copy amazing-grace-no-art.mp3
 *
 * The app runs with its own data directory in `<repo>/.local/readme-shots/data`, seeded with the models and tools of the
 * data directory in TUNESTUDIO_README_MODELS (default: the dev app's, `~/Library/Application Support/Tune Studio Dev`,
 * copied as APFS clones) so nothing is downloaded twice; whatever is missing is downloaded as the app normally does.
 * The projects are made through the real "new project from an audio file" flow (voice separation, the typed lyrics,
 * the chart) and kept, so a second run only takes the pictures (all but the new-project one, taken while making them);
 * delete `.local/readme-shots` to make them again.
 * Raw shots land in `.local/readme-shots/raw`, the README's (downscaled with `sips`, macOS) in `<repo>/docs/images`.
 * Runs under Node, since Playwright's Electron driver doesn't connect under Bun.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Page } from "@playwright/test";

import { appDir, launchStudio, type Studio } from "./app.ts";
import { answerDialogs, stubDesktop } from "./fixtures.ts";

/** Public domain lyrics, the verses this recording sings. */
const LYRICS = `Amazing grace, how sweet the sound
That saved a wretch like me
I once was lost, but now am found
Was blind, but now I see
'Twas grace that taught my heart to fear
And grace my fears relieved
How precious did that grace appear
The hour I first believed
When we've been there ten thousand years
Bright shining as the sun
We've no less days to sing God's praise
Than when we'd first begun`;

interface Song {
  artist: string;
  title: string;
  /** The cover's two gradient colours. */
  colors: [string, string];
  /** Charted from the lyrics; the others are only there to fill the recent projects. */
  charted?: boolean;
}

/** Oldest first: the last one opened leads the recent projects. */
const SONGS: Song[] = [
  { artist: "Traditional", title: "Shenandoah", colors: ["#1d3b4f", "#6b9a7a"] },
  { artist: "Traditional", title: "Danny Boy", colors: ["#2f2a4a", "#b0705a"] },
  { artist: "Southern Aire", title: "Amazing Grace", colors: ["#22352a", "#c8b46a"], charted: true },
];

const argument = process.argv.slice(2).find((arg) => arg !== "--");
const audio = path.resolve(argument ?? process.env.TUNESTUDIO_README_SONG ?? "");
if (!argument && !process.env.TUNESTUDIO_README_SONG) {
  console.error("Usage: node e2e/readme-shots.ts <audio file of Amazing Grace>");
  process.exit(1);
}
if (!fs.statSync(audio, { throwIfNoEntry: false })?.isFile()) {
  console.error(`No audio file at ${audio}`);
  process.exit(1);
}

const repo = path.resolve(appDir, "../..");
const workDir = path.join(repo, ".local/readme-shots");
const dataDir = path.join(workDir, "data");
const projectsDir = path.join(workDir, "projects");
const coversDir = path.join(workDir, "covers");
const rawDir = path.join(workDir, "raw");
const imagesDir = path.join(repo, "docs/images");
for (const dir of [dataDir, projectsDir, coversDir, rawDir, imagesDir]) fs.mkdirSync(dir, { recursive: true });

/** Copies the models and tools another data directory already has (clones on APFS, so they take no space). */
function seedDataDir() {
  const source =
    process.env.TUNESTUDIO_README_MODELS ?? path.join(os.homedir(), "Library/Application Support/Tune Studio Dev");
  for (const name of ["models", "tools"]) {
    const from = path.join(source, name);
    const to = path.join(dataDir, name);
    if (fs.existsSync(to) || !fs.existsSync(from)) continue;
    try {
      execFileSync("cp", ["-cR", from, to]);
    } catch {
      fs.cpSync(from, to, { recursive: true });
    }
  }
}

const projectFile = (song: Song) => path.join(projectsDir, `${song.artist} - ${song.title}.tunestudio`);
const coverFile = (song: Song) => path.join(coversDir, `${song.title}.png`);

/** An original cover: a gradient, a few staff lines and the title, drawn on a canvas in the app's page. */
async function drawCover(page: Page, song: Song) {
  const url = await page.evaluate(
    ({ title, artist, colors }) => {
      const size = 800;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d")!;
      const gradient = context.createLinearGradient(0, 0, size, size);
      gradient.addColorStop(0, colors[0]);
      gradient.addColorStop(1, colors[1]);
      context.fillStyle = gradient;
      context.fillRect(0, 0, size, size);
      context.strokeStyle = "rgba(255, 255, 255, 0.16)";
      context.lineWidth = 3;
      for (let line = 0; line < 5; line++) {
        const y = 300 + line * 34;
        context.beginPath();
        context.moveTo(0, y);
        context.bezierCurveTo(size * 0.35, y - 60, size * 0.65, y + 60, size, y - 20);
        context.stroke();
      }
      context.fillStyle = "rgba(255, 255, 255, 0.2)";
      const heads: [number, number][] = [
        [180, 318],
        [300, 290],
        [430, 352],
        [560, 330],
      ];
      for (const [x, y] of heads) {
        context.beginPath();
        context.ellipse(x, y, 22, 16, -0.4, 0, Math.PI * 2);
        context.fill();
      }
      context.fillStyle = "rgba(255, 255, 255, 0.94)";
      context.font = "600 84px 'DM Sans Variable', sans-serif";
      context.fillText(title, 64, size - 140);
      context.fillStyle = "rgba(255, 255, 255, 0.7)";
      context.font = "400 36px 'DM Sans Variable', sans-serif";
      context.fillText(artist, 66, size - 84);
      return canvas.toDataURL("image/png");
    },
    { title: song.title, artist: song.artist, colors: song.colors },
  );
  fs.writeFileSync(coverFile(song), Buffer.from(url.split(",")[1]!, "base64"));
}

const LONG = { timeout: 15 * 60_000 };

async function shot(studio: Studio, name: string) {
  await studio.page.waitForTimeout(400);
  const raw = path.join(rawDir, `${name}.png`);
  await studio.page.screenshot({ path: raw });
  console.log(`  ${name}.png`);
  return raw;
}

/** Writes the README's copy of a shot, 1440 px wide. */
function publish(raw: string, name: string) {
  const target = path.join(imagesDir, `${name}.png`);
  execFileSync("sips", ["--resampleWidth", "1440", raw, "--out", target], { stdio: "ignore" });
  console.log(`  -> docs/images/${name}.png (${Math.round(fs.statSync(target).size / 1024)} KB)`);
}

/** A project from the audio file, through the app's own flow. */
async function createProject(studio: Studio, song: Song) {
  const { app, page } = studio;
  await page.getByTestId("audio-input").setInputFiles(audio);
  const dialog = page.getByTestId("flow-dialog");
  await dialog.waitFor();
  // FFmpeg first (when missing), then the file is read.
  await page.getByTestId("audio-artist").waitFor(LONG);
  await page.getByTestId("audio-artist").fill(song.artist);
  await page.getByTestId("audio-title").fill(song.title);
  await page.getByTestId("song-language").click();
  await page.getByRole("option", { name: "English" }).click();
  await answerDialogs(app, coverFile(song));
  await page.getByTestId("cover-choose").click();
  await page.getByTestId("cover-file").waitFor();
  // Copying the song and separating the voice.
  await page.getByTestId("flow-next").click();
  await page.getByTestId("lyrics-review").waitFor(LONG);
  await page
    .getByRole("button", { name: "Your own" })
    .or(page.getByRole("radio", { name: "Your own" }))
    .click();
  if (song.charted) {
    await page.getByTestId("lyrics-text").fill(LYRICS);
    await page.mouse.move(0, 0);
    publish(await shot(studio, "new-project-lyrics"), "new-project-lyrics");
  }
  await page.getByTestId("flow-next").click();
  await page.getByTestId("chart-choice").waitFor();
  await page.getByTestId(song.charted ? "chart-make" : "chart-later").click();
  await page.getByTestId("flow-next").click();
  // Making the chart (charted songs), then the summary.
  await page.getByTestId("finish-summary").waitFor(LONG);
  await answerDialogs(app, projectFile(song));
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByTestId("project").waitFor(LONG);
  await page.getByTestId("close-project").click();
  await page.getByTestId("home").waitFor();
}

seedDataDir();
const studio = await launchStudio({ width: 1440, height: 900, online: true, dataDir });
const { app, page } = studio;
await stubDesktop(app);

try {
  for (const song of SONGS) {
    if (fs.existsSync(projectFile(song))) continue;
    console.log(`Making ${song.title}…`);
    await drawCover(page, song);
    await createProject(studio, song);
  }

  // The start screen with its recent projects.
  await page.getByTestId("recent-item").first().waitFor();
  await page.mouse.move(0, 0);
  publish(await shot(studio, "home"), "home");

  // The editor on the charted song.
  await page.getByTestId("recent-item").filter({ hasText: "Amazing Grace" }).click();
  await page.getByTestId("project").waitFor(LONG);
  await page.getByTestId("roll-note").first().waitFor();
  await page.mouse.move(0, 0);
  // A few lines in view: the playhead on the second line, zoomed out around it.
  for (let i = 0; i < 4; i++) await page.keyboard.press(".");
  for (let i = 0; i < 2; i++) await page.getByRole("button", { name: "Zoom out" }).click();
  await page.mouse.move(0, 0);
  publish(await shot(studio, "editor"), "editor");

  // The note menu on a selected note.
  const notes = page.getByTestId("roll-note");
  await notes.filter({ hasText: "wretch" }).click({ button: "right" });
  await page.getByTestId("note-menu").waitFor();
  publish(await shot(studio, "editor-note-menu"), "editor-note-menu");
  await page.keyboard.press("Escape");
  await page.getByTestId("note-menu").waitFor({ state: "hidden" });

  // A duet: a second singer takes the third line. Undone afterwards, so the project stays as charted.
  const addSinger = page.getByTestId("add-singer");
  if (await addSinger.isVisible()) {
    await addSinger.click();
    await page.getByTestId("singer-name").fill("Harmony");
    await page.getByTestId("singer-name").press("Enter");
    await page.getByTestId("singer-name").waitFor({ state: "hidden" });
  }
  try {
    // Every note between the line breaks around "once": a selection box from break to break.
    const once = (await notes.filter({ hasText: "once" }).first().boundingBox())!;
    const breaks = await page.getByTestId("break-marker").evaluateAll((markers) =>
      markers.map((marker) => {
        const box = marker.getBoundingClientRect();
        return box.x + box.width / 2;
      }),
    );
    const from = Math.max(...breaks.filter((x) => x < once.x));
    const to = Math.min(...breaks.filter((x) => x > once.x));
    const roll = (await page.getByTestId("piano-roll").boundingBox())!;
    await page.mouse.move(from + 6, roll.y + 4);
    await page.mouse.down();
    await page.mouse.move(to - 6, roll.y + roll.height - 4, { steps: 6 });
    await page.mouse.up();
    await page
      .getByTestId("sung-by")
      .getByRole("button")
      .or(page.getByTestId("sung-by").getByRole("radio"))
      .nth(1)
      .click();
    await page.mouse.move(0, 0);
    publish(await shot(studio, "editor-duet"), "editor-duet");
  } finally {
    await page.keyboard.press("Escape");
    const undo = page.getByTestId("undo");
    while (!(await addSinger.isVisible()) && (await undo.isEnabled())) await undo.click();
  }

  for (const problem of studio.problems) console.log(problem.split("\n")[0]);
} finally {
  await studio.close();
}
