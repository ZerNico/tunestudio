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

test("the note menu acts on the selection, pastes on empty space, and auto pitch has a button", async () => {
  await openSong();
  const { page } = studio;
  const notes = page.getByTestId("roll-note");
  const menu = page.getByTestId("note-menu");
  const autoPitch = page.getByTestId("auto-pitch");
  await expect(autoPitch).toBeDisabled();

  // A right-click selects the note; the menu's type toggles it.
  await notes.nth(0).click({ button: "right" });
  await expect(notes.nth(0)).toHaveAttribute("data-selected", "true");
  await menu.getByText("Golden").click();
  await expect(menu).toBeHidden();
  await expect(notes.nth(0)).toHaveAttribute("data-type", "golden");
  // Merging one note can't be done; the menu says so up front.
  await notes.nth(0).click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: /Merge/ })).toHaveAttribute("aria-disabled", "true");
  await menu.getByText("Copy").click();
  expect(await studio.app.evaluate(({ clipboard }) => clipboard.readText())).toBe("Hel");

  // On empty space: Paste (at the playhead, through main for the clipboard's text).
  await seekTo(0.8);
  const area = (await page.getByTestId("roll-area").boundingBox())!;
  await page.mouse.click(area.x + area.width - 20, area.y + 12, { button: "right" });
  await expect(menu.getByText("Golden")).toHaveCount(0);
  await menu.getByText("Paste").click();
  await expect(notes).toHaveCount(6);
  await expect(page.getByTestId("undo")).toHaveAttribute("aria-label", "Undo Paste note");

  // The pasted note is selected: the button runs auto pitch, which needs the vocals this song doesn't have.
  await expect(autoPitch).toBeEnabled();
  await autoPitch.click();
  await expect(page.getByText("The song needs its vocals separated first.")).toBeVisible();
  await expect(autoPitch).toBeVisible();
});

test("a drag on the ruler loops a range, L loops the selected notes, a double-click removes the range", async () => {
  await openSong();
  const { page } = studio;
  const ruler = (await page.getByTestId("time-ruler").boundingBox())!;
  const range = page.getByTestId("loop-range");
  const loop = page.getByTestId("loop");
  await expect(loop).toHaveAttribute("aria-pressed", "false");
  // Nothing to loop yet.
  await page.keyboard.press("l");
  await expect(page.getByText("Drag on the time ruler or select notes to loop them.")).toBeVisible();

  await page.mouse.move(ruler.x + ruler.width * 0.3, ruler.y + ruler.height / 2);
  await page.mouse.down();
  await page.mouse.move(ruler.x + ruler.width * 0.6, ruler.y + ruler.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(range).toBeVisible();
  await expect(range).toHaveAttribute("data-on", "");
  await expect(loop).toHaveAttribute("aria-pressed", "true");
  // L: off (the range stays), and on again.
  await page.keyboard.press("l");
  await expect(loop).toHaveAttribute("aria-pressed", "false");
  await expect(range).not.toHaveAttribute("data-on");
  // On the ruler where the range is (the band itself lets presses through to the ruler).
  const band = (await range.boundingBox())!;
  await page.mouse.dblclick(band.x + band.width / 2, band.y + band.height / 2);
  await expect(range).toHaveCount(0);

  // The selected note: the range is just around it.
  const note = page.getByTestId("roll-note").first();
  await note.click();
  await page.keyboard.press("l");
  const noteBox = (await note.boundingBox())!;
  const rangeBox = (await range.boundingBox())!;
  expect(Math.abs(rangeBox.x - noteBox.x)).toBeLessThan(3);
  expect(Math.abs(rangeBox.x + rangeBox.width - (noteBox.x + noteBox.width))).toBeLessThan(3);
});

test("the rows grow while a note is dragged past them, and fit the notes again after", async () => {
  await openSong();
  const { page } = studio;
  const rows = page.getByTestId("roll-row");
  const before = await rows.count();
  const note = (await page.getByTestId("roll-note").nth(2).boundingBox())!;
  const area = (await page.getByTestId("roll-area").boundingBox())!;
  await page.mouse.move(note.x + note.width / 2, note.y + note.height / 2);
  await page.mouse.down();
  // Held above the roll: the rows grow a semitone at a time before it is let go.
  await page.mouse.move(note.x + note.width / 2, area.y - 30, { steps: 6 });
  await expect.poll(() => rows.count()).toBeGreaterThan(before + 2);
  await page.mouse.up();
  const grown = await rows.count();
  // Undone: the notes are where they were, and so are the rows.
  await page.getByTestId("undo").click();
  await expect(rows).toHaveCount(before);
  expect(grown).toBeGreaterThan(before);
});

test("song details are edited in a dialog from the title bar, exported, and undone", async () => {
  await openSong();
  const { app, page } = studio;
  const name = page.getByTestId("open-song-details");
  await name.click();
  const dialog = page.getByTestId("song-details");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("song-title").fill("Day Signals");
  await dialog.getByTestId("song-title").press("Enter");
  await dialog.getByTestId("song-tags").fill("live, acoustic");
  await dialog.getByTestId("song-tags").press("Tab");
  // The cover: removed, then an image file picked instead (in its own dialog).
  const cover = dialog.getByTestId("file-cover");
  await expect(cover.locator("img")).toBeVisible();
  await cover.getByTestId("remove-cover").click();
  await expect(cover).toContainText("None");
  await cover.getByRole("button", { name: "Add…" }).click();
  const coverDialog = page.getByTestId("cover-dialog");
  await expect(coverDialog).toBeVisible();
  await answerDialogs(app, path.join(song.folder, "cover.png"));
  await coverDialog.getByTestId("cover-choose").click();
  await expect(coverDialog).toBeHidden();
  await expect.poll(() => cover.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(name).toContainText("Day Signals");
  await expect(page.getByTestId("undo")).toHaveAttribute("aria-label", "Undo Change tags");

  // Exported with them.
  const exports = path.join(song.dir, "Exports");
  fs.mkdirSync(exports);
  await answerDialogs(app, exports);
  await page.getByTestId("export-song").click();
  await expect(page.getByText("Exported the UltraStar song")).toBeVisible();
  const chart = fs.readFileSync(
    path.join(exports, "Test Artist - Day Signals", "Test Artist - Day Signals.txt"),
    "utf8",
  );
  expect(chart).toContain("#TITLE:Day Signals\n");
  expect(chart).toContain("#TAGS:live, acoustic\n");
  expect(fs.readdirSync(path.join(exports, "Test Artist - Day Signals"))).toContain(
    "Test Artist - Day Signals [CO].png",
  );

  await page.getByTestId("undo").click();
  await page.getByTestId("undo").click();
  await expect(name).toContainText("Night Signals");
});

test("start, end, preview and medley are set from the dialog and the timeline, and exported", async () => {
  await openSong();
  const { app, page } = studio;
  // The first line's notes: the medley.
  const notes = page.getByTestId("roll-note");
  await notes.nth(0).click();
  await notes.nth(2).click({ modifiers: ["Shift"] });
  await seekTo(0.1);
  await page.getByTestId("open-song-details").click();
  const timing = page.getByTestId("song-timing");
  await timing.getByTestId("timing-start").getByRole("button", { name: "Playhead" }).click();
  await timing.getByTestId("timing-preview").getByRole("button", { name: "Playhead" }).click();
  await timing.getByTestId("timing-medley").getByRole("button", { name: "Selected lines" }).click();
  await expect(timing.getByTestId("timing-medley").getByTestId("timing-value")).not.toHaveText("Not set");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("song-details")).toBeHidden();
  await expect(page.getByTestId("medley-band")).toBeVisible();
  await expect(page.getByTestId("marker-preview")).toBeVisible();

  // The end handle, dragged in from the song's end: what is after it is dimmed.
  const end = (await page.getByTestId("marker-end").boundingBox())!;
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x - 200, end.y + end.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("undo")).toHaveAttribute("aria-label", "Undo Move end");
  await expect(page.getByTestId("not-played-after")).toBeVisible();

  const exports = path.join(song.dir, "Exports");
  fs.mkdirSync(exports);
  await answerDialogs(app, exports);
  await page.getByTestId("export-song").click();
  await expect(page.getByText("Exported the UltraStar song")).toBeVisible();
  const chart = fs.readFileSync(
    path.join(exports, "Test Artist - Night Signals", "Test Artist - Night Signals.txt"),
    "utf8",
  );
  for (const header of ["#START:", "#END:", "#PREVIEWSTART:", "#MEDLEYSTARTBEAT:", "#MEDLEYENDBEAT:"])
    expect(chart).toContain(header);
});

test("scrubbing to the roll's edge scrolls the view, and the playhead goes on with it", async () => {
  await openSong();
  const { page } = studio;
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Zoom in" }).click();
  const ruler = page.getByTestId("time-ruler");
  const ticks = () => ruler.locator("span").allTextContents();
  const before = await ticks();
  const box = (await ruler.boundingBox())!;
  // The playhead's head (a drag on the ruler itself marks a loop range), brought into view with a click.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const head = (await page.getByTestId("playhead-head").boundingBox())!;
  await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
  await page.mouse.down();
  // Held just inside the right edge: the view scrolls on, the playhead with it.
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 8 });
  await expect.poll(async () => (await ticks())[0]).not.toBe(before[0]);
  await page.mouse.up();
  const time = await page.getByTestId("transport-time").textContent();
  // Past the last tick that was in view before.
  expect(time!.split("/")[0]!.trim() > before.at(-1)!).toBe(true);
});
