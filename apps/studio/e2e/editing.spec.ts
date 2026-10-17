import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { launchStudio, type Studio } from "./app.ts";
import { answerDialogs, makePlayable, type SongFixture, songFixture, stubDesktop } from "./fixtures.ts";

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
  // Song, then Finish.
  await page.getByTestId("flow-dialog").getByTestId("flow-next").click();
  await page.getByTestId("flow-dialog").getByRole("button", { name: "Create project" }).click();
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

test("line breaks are selected with the notes, move with them, and are grabbed on the roll too", async () => {
  await openSong();
  const { page } = studio;
  const notes = page.getByTestId("roll-note");
  const marker = page.getByTestId("break-marker");
  const line = page.getByTestId("line-break");
  const undo = page.getByTestId("undo");

  // Everything: the break too, drawn as selected in the lane and the roll.
  await notes.nth(0).click();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(marker).toHaveAttribute("data-selected", "true");
  await expect(line).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Escape");
  await expect(marker).not.toHaveAttribute("data-selected", "true");

  // A note of the second line and the break (Shift on its marker) move together.
  await notes.nth(4).click();
  await marker.click({ modifiers: ["Shift"] });
  await expect(marker).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(undo).toHaveAttribute("aria-label", "Undo Move note and line break");

  // The break's line in the roll is grabbed as its marker is: a drag moves just the break.
  await page.keyboard.press("Escape");
  const grip = (await page.getByTestId("line-break-grip").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 - 30, grip.y + grip.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(undo).toHaveAttribute("aria-label", "Undo Move line break");
  await expect(marker).toHaveAttribute("data-selected", "true");
  await expect(notes.nth(0)).not.toHaveAttribute("data-selected", "true");
});

test("a line break goes after the selected notes, or at the playhead, with the button and B, with default timing", async () => {
  await openSong();
  const { page } = studio;
  const notes = page.getByTestId("roll-note");
  const markers = page.getByTestId("break-marker");
  await notes.nth(1).click();
  await page.getByTestId("line-break-after").click();
  await expect(markers).toHaveCount(2);
  await expect(page.getByTestId("undo")).toHaveAttribute("aria-label", "Undo Add line break");
  await notes.nth(3).click();
  await page.keyboard.press("b");
  await expect(markers).toHaveCount(3);
  for (const marker of await markers.all()) await expect(marker).toHaveAttribute("data-auto", "");
  // After a line's last note there is nothing to split.
  await notes.nth(4).click();
  await page.keyboard.press("b");
  await expect(page.getByText("That's already the end of a line.")).toBeVisible();
  await expect(markers).toHaveCount(3);
  // With nothing selected it goes at the playhead: in a gap that has a break already, none is added elsewhere.
  await page.keyboard.press("Escape");
  const world = (await notes.nth(2).boundingBox())!;
  const good = (await notes.nth(3).boundingBox())!;
  const ruler = (await page.getByTestId("time-ruler").boundingBox())!;
  await page.mouse.click((world.x + world.width + good.x) / 2, ruler.y + ruler.height / 2);
  await page.getByTestId("line-break-after").click();
  await expect(page.getByText("There's already a line break here.")).toBeVisible();
  await expect(markers).toHaveCount(3);
});

test("a dragged line break keeps its time until Reset timing in its menu", async () => {
  await openSong();
  const { page } = studio;
  const marker = page.getByTestId("break-marker");
  // The fixture's break is at the default spot: default timing, drawn as an outline.
  await expect(marker).toHaveAttribute("data-auto", "");
  const box = (await marker.boundingBox())!;
  const area = { x: box.x - 160, y: box.y - 40, width: 320, height: 160 };
  await page.screenshot({ path: test.info().outputPath("break-default.png"), clip: area });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(marker).not.toHaveAttribute("data-auto");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: test.info().outputPath("break-stored.png"), clip: { ...area, x: area.x - 20 } });
  await marker.click({ button: "right" });
  await page.getByTestId("break-menu").getByRole("menuitem", { name: "Reset timing" }).click();
  await expect(marker).toHaveAttribute("data-auto", "");
  await expect(page.getByTestId("undo")).toHaveAttribute("aria-label", "Undo Reset line break timing");
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

  // The pasted note is selected: the button runs auto pitch, which can't get FFmpeg offline (tests never download).
  await expect(autoPitch).toBeEnabled();
  await autoPitch.click();
  await expect(page.getByText("Couldn't find the pitch")).toBeVisible();
  await expect(autoPitch).toBeVisible();
});

test("charts lyrics for a reviewed ruler range and leaves notes intact on failure", async () => {
  await openSong();
  const { page } = studio;
  const button = page.getByTestId("chart-range");
  const dialog = page.getByTestId("chart-range-dialog");
  // Nothing to chart yet: it says how to choose a range.
  await button.click();
  await expect(page.getByText("Drag on the time ruler or select notes to chart them.")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByTestId("roll-note").first().click();
  await button.click();
  await expect(dialog.getByRole("textbox", { name: "Lyrics" })).toHaveValue("Hel");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const ruler = (await page.getByTestId("time-ruler").boundingBox())!;
  await page.mouse.move(ruler.x + ruler.width * 0.15, ruler.y + ruler.height / 2);
  await page.mouse.down();
  await page.mouse.move(ruler.x + ruler.width * 0.55, ruler.y + ruler.height / 2, { steps: 5 });
  await page.mouse.up();
  // With looping off and nothing selected, the faint range left on the ruler doesn't count.
  await page.getByTestId("loop").click();
  await expect(page.getByTestId("loop")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await button.click();
  // The first click's hint may still be showing.
  await expect(page.getByText("Drag on the time ruler or select notes to chart them.")).toHaveCount(2);
  await expect(dialog).toHaveCount(0);
  await page.getByTestId("loop").click();
  await expect(page.getByTestId("loop")).toHaveAttribute("aria-pressed", "true");
  await button.click();
  const lyrics = dialog.getByRole("textbox", { name: "Lyrics" });
  await expect(lyrics).not.toHaveValue("Hel");
  await lyrics.fill("Hello world\n(oh) again");
  await expect(dialog.getByRole("button", { name: "Chart range", exact: true })).toBeEnabled();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: test.info().outputPath("chart-range-dialog.png"), animations: "disabled" });
  await dialog.getByRole("button", { name: "Chart range", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(lyrics).toHaveValue("Hello world\n(oh) again");
  await expect(page.getByTestId("roll-note")).toHaveCount(5);
  await expect(page.getByTestId("undo")).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("makes a duet: adds and names a singer, gives them a line, hides them, exports and undoes", async () => {
  await openSong();
  const { app, page } = studio;
  const notes = page.getByTestId("roll-note");
  await page.getByRole("button", { name: "Add singer", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Name of P2" });
  await expect(name).toBeFocused();
  await name.fill("Ben");
  await name.press("Enter");
  await expect(page.getByRole("button", { name: "Ben, P2" })).toHaveAttribute("aria-pressed", "true");
  // Renamed again from the chip's context menu.
  await page.getByRole("button", { name: "Ben, P2" }).click({ button: "right" });
  await page.getByTestId("singer-menu").getByRole("menuitem", { name: "Rename" }).click();
  await expect(name).toBeFocused();
  await name.fill("Benji");
  await name.press("Enter");
  await expect(page.getByRole("button", { name: "Benji, P2" })).toBeVisible();

  // The first line ("Hello world") goes to Ben with Sung by.
  await notes.nth(0).click();
  await notes.nth(2).click({ modifiers: ["Shift"] });
  await expect(page.getByRole("button", { name: "Sung by P1" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Sung by Benji" }).click();
  await expect(page.getByTestId("undo")).toHaveAttribute("aria-label", "Undo Move 3 notes to Benji");
  await expect(notes.and(page.locator('[data-singer="2"]'))).toHaveCount(3);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: test.info().outputPath("duet.png"), animations: "disabled" });

  // Hidden, Ben's notes are out of the roll; shown again, they're back.
  await page.getByRole("button", { name: "Hide Benji" }).click();
  await expect(notes).toHaveCount(2);
  await page.getByRole("button", { name: "Show Benji" }).click();
  await expect(notes).toHaveCount(5);

  const exports = path.join(song.dir, "Exports");
  fs.mkdirSync(exports);
  await answerDialogs(app, exports);
  await page.getByTestId("export-song").click();
  await page.getByTestId("export-folder").click();
  await expect(page.getByText("Exported for games")).toBeVisible();
  const chart = fs.readFileSync(
    path.join(exports, "Test Artist - Night Signals", "Test Artist - Night Signals.txt"),
    "utf8",
  );
  expect(chart).toContain("#P2:Benji\n");
  expect(chart).toMatch(/\nP1\n[\s\S]*\nP2\n/);

  // The move undone: the notes are P1's again, selected, and P1 is the active singer.
  await page.getByTestId("undo").click();
  await expect(notes.and(page.locator('[data-singer="2"]'))).toHaveCount(0);
  await expect(page.getByRole("button", { name: "P1, P1" })).toHaveAttribute("aria-pressed", "true");
  // Both renames and add undone: solo again.
  for (let i = 0; i < 3; i++) await page.getByTestId("undo").click();
  await expect(page.getByRole("button", { name: "Add singer", exact: true })).toBeVisible();
  await expect(notes.and(page.locator('[data-singer="2"]'))).toHaveCount(0);
});

test("in a duet, clicks where the singers coincide go to the active singer, even over the other's selection", async () => {
  await openSong();
  const { page } = studio;
  const notes = page.getByTestId("roll-note");
  const p1 = (locator: ReturnType<typeof page.getByTestId>) => locator.and(page.locator('[data-singer="1"]'));
  const p2 = (locator: ReturnType<typeof page.getByTestId>) => locator.and(page.locator('[data-singer="2"]'));
  /** The test id and singer of what the browser hits at the middle of `box` (what a click there would press). */
  const hitAt = (box: { x: number; y: number; width: number; height: number }) =>
    page.evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y)?.closest("[data-testid]");
        return { testid: element?.getAttribute("data-testid"), singer: element?.getAttribute("data-singer") };
      },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );

  await page.getByRole("button", { name: "Add singer", exact: true }).click();
  await page.getByRole("textbox", { name: "Name of P2" }).press("Enter");
  // Both lines copied to P2: the copies (and the break between them) lie exactly on P1's, selected; P2 is active.
  await notes.nth(0).click();
  await notes.nth(4).click({ modifiers: ["Shift"] });
  await notes.nth(0).click({ button: "right" });
  await page
    .getByTestId("note-menu")
    .getByRole("menuitem", { name: /^Copy to/ })
    .click();
  await expect(p2(notes)).toHaveCount(5);
  await expect(p2(notes).first()).toHaveAttribute("data-selected", "true");

  // P1 chosen: P2's copies stay selected (drawn so) but dimmed under P1's notes, so a click picks P1's note.
  await page.getByRole("button", { name: "P1, P1" }).click();
  await expect(p2(notes).first()).toHaveAttribute("data-inactive", "");
  await expect(p2(notes).first()).toHaveAttribute("data-selected", "true");
  const note = (await p1(notes).first().boundingBox())!;
  // Hovered too (the pointer over both), P2's selected copy stays under.
  await page.mouse.move(note.x + note.width / 2, note.y + note.height / 2);
  expect(await hitAt(note)).toEqual({ testid: "roll-note", singer: "1" });
  await page.mouse.click(note.x + note.width / 2, note.y + note.height / 2);
  await expect(p1(notes).first()).toHaveAttribute("data-selected", "true");
  await expect(p2(notes).first()).not.toHaveAttribute("data-selected", "true");
  await expect(page.getByRole("button", { name: "P1, P1" })).toHaveAttribute("aria-pressed", "true");

  // The line breaks where the singers' lines end together: P1's marker and grip take the press, not P2's.
  const markers = page.getByTestId("break-marker");
  const marker = (await p1(markers).first().boundingBox())!;
  const other = (await p2(markers).first().boundingBox())!;
  expect(Math.abs(marker.x - other.x)).toBeLessThan(1);
  await page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
  expect(await hitAt(marker)).toEqual({ testid: "break-marker", singer: "1" });
  await page.mouse.click(marker.x + marker.width / 2, marker.y + marker.height / 2);
  await expect(p1(markers).first()).toHaveAttribute("data-selected", "true");
  await expect(p2(markers).first()).not.toHaveAttribute("data-selected", "true");
  const grips = page.getByTestId("line-break-grip");
  const grip = (await p1(grips).first().boundingBox())!;
  // At the roll's top, above the notes (the rows leave room), where only the grips are.
  const top = { ...grip, y: grip.y + 4, height: 0 };
  expect(await hitAt(top)).toEqual({ testid: "line-break-grip", singer: "1" });
  await page.keyboard.press("Escape");
  await page.mouse.click(top.x + top.width / 2, top.y);
  await expect(p1(markers).first()).toHaveAttribute("data-selected", "true");
  await expect(p2(markers).first()).not.toHaveAttribute("data-selected", "true");
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
  await cover.getByRole("button", { name: "Add" }).click();
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
  await page.getByTestId("export-folder").click();
  await expect(page.getByText("Exported for games")).toBeVisible();
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

test("help opens with ? or its button, and lists the keys the tooltips show", async () => {
  await openSong();
  const { page } = studio;
  const help = page.getByTestId("help");
  await page.keyboard.press("?");
  await expect(help).toBeVisible();
  await expect(help.getByTestId("help-keys").first()).toBeVisible();
  await expect(help).toContainText("Line break after the selection, or at the playhead");
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await page.getByTestId("help-open").click();
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();

  // Holding Cmd (Ctrl) on its own shows the buttons' keys; letting go hides them.
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await expect(page.getByTestId("tool-draw").getByTestId("key-hint")).toHaveText("D");
  await page.keyboard.up(modifier);
  await expect(page.getByTestId("key-hint")).toHaveCount(0);
});

test("singing along draws the microphone's pitch over the notes", async () => {
  // Audio that plays (silence), so playback runs; the microphone is a 220 Hz tone (A3).
  makePlayable(song);
  await openSong();
  const { page } = studio;
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const tone = context.createOscillator();
      tone.frequency.value = 220;
      const out = context.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      return out.stream;
    };
  });
  await page.getByTestId("sing-along").click();
  await expect(page.getByTestId("sing-along")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press(" ");
  await expect(page.getByTestId("voice-trace")).toBeVisible({ timeout: 5000 });
  // Something gets drawn: the canvas has lit pixels.
  const lit = () =>
    page.getByTestId("voice-trace").evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      return data.some((value, i) => i % 4 === 3 && value > 0);
    });
  await expect.poll(lit, { timeout: 5000 }).toBe(true);
  await page.keyboard.press(" ");
  await page.getByTestId("sing-along").click();
  await expect(page.getByTestId("voice-trace")).toHaveCount(0);
});

test("a line's lyrics are edited as text, matched word by word onto its notes", async () => {
  await openSong();
  const { page } = studio;
  const notes = page.getByTestId("roll-note");
  await page.getByTestId("lyrics-line").first().dblclick();
  const input = page.getByTestId("line-text-input");
  await expect(input).toHaveValue("Hel-lo world");
  // A new word with no notes to go on: refused, the text stays to be fixed.
  await input.fill("Hel-lo big world");
  await input.press("Enter");
  await expect(page.getByText("“big” has no notes. Draw them first.")).toBeVisible();
  await expect(input).toHaveValue("Hel-lo big world");
  await input.fill("Hel-lo earth");
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await expect(notes.nth(2)).toContainText("earth");
  await expect(notes).toHaveCount(5);
  await expect(page.getByTestId("undo")).toHaveAttribute("aria-label", "Undo Edit line lyrics");
  // From the note menu, Esc cancels.
  await notes.nth(3).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit line lyrics" }).click();
  // The fixture has no space after "good": one word, as games read it.
  await expect(input).toHaveValue("good-bye");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
});

test("a new gap moves the whole chart with it, exported with the same beats", async () => {
  await openSong();
  const { app, page } = studio;
  const first = (await page.getByTestId("roll-note").first().boundingBox())!;
  await page.getByTestId("open-song-details").click();
  const dialog = page.getByTestId("song-details");
  const gap = dialog.getByTestId("gap");
  await expect(gap).toHaveValue("1250");
  await gap.fill("1500");
  await gap.press("Enter");
  await expect(page.getByTestId("undo")).toHaveAttribute("aria-label", "Undo Change gap");
  // Too far back: the first note would start before the song.
  await gap.fill("-5000");
  await gap.press("Enter");
  await expect(dialog.getByRole("alert")).toHaveText("Notes would start before the song.");
  await expect(gap).toHaveValue("1500");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const moved = (await page.getByTestId("roll-note").first().boundingBox())!;
  expect(moved.x).toBeGreaterThan(first.x);

  const exports = path.join(song.dir, "Exports");
  fs.mkdirSync(exports);
  await answerDialogs(app, exports);
  await page.getByTestId("export-song").click();
  await page.getByTestId("export-folder").click();
  await expect(page.getByText("Exported for games")).toBeVisible();
  const chart = fs.readFileSync(
    path.join(exports, "Test Artist - Night Signals", "Test Artist - Night Signals.txt"),
    "utf8",
  );
  expect(chart).toContain("#GAP:1500\n");
  expect(chart).toContain(": 0 4 2 Hel\n");
  expect(chart).toContain("- 18\n");
  expect(chart).toContain(": 24 6 -3 bye\n");
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
  await page.getByTestId("export-folder").click();
  await expect(page.getByText("Exported for games")).toBeVisible();
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

test("the title bar lists the chart's problems and shows the one chosen", async () => {
  const { page } = studio;
  await openSong();
  await expect(page.getByTestId("problems")).toHaveAccessibleName("No problems found");

  // "Hel" made a step longer runs into "lo".
  const notes = page.getByTestId("roll-note");
  await notes.filter({ hasText: "Hel" }).click();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.getByTestId("problems")).toHaveText("1");

  // Choosing it selects both notes.
  await page.keyboard.press("Escape");
  await page.getByTestId("problems").click();
  await page.getByTestId("problem").filter({ hasText: "Notes overlap" }).click();
  await expect(notes.filter({ hasText: "Hel" })).toHaveAttribute("data-selected", "true");
  await expect(notes.filter({ hasText: /^\W*lo\s*$/ })).toHaveAttribute("data-selected", "true");

  // Undone, nothing is wrong again.
  await page.keyboard.press("Escape");
  await page.getByTestId("undo").click();
  await expect(page.getByTestId("problems")).toHaveAccessibleName("No problems found");
});

test("Tab stays inside a dialog, going round from the last control to the first", async () => {
  const { page } = studio;
  await openSong();
  await page.getByTestId("open-song-details").click();
  const dialog = page.getByTestId("song-details");
  await expect(dialog).toBeVisible();
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      return {
        inDialog: Boolean(element?.closest("[data-testid=song-details]")),
        label: element?.getAttribute("aria-label") ?? element?.dataset.testid ?? "",
      };
    });
  // Tab goes round: from the close button through every control and back to it, never out of the dialog (the focus
  // guard at the end hands focus on a frame later).
  await dialog.getByRole("button", { name: "Close dialog" }).focus();
  const seen: string[] = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(40);
    const now = await focused();
    expect(now.inDialog).toBe(true);
    seen.push(now.label);
    if (now.label === "Close dialog") break;
  }
  expect(seen.at(-1)).toBe("Close dialog");
  expect(seen.length).toBeGreaterThan(10);
  // Back the other way, past the first control.
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(40);
  expect((await focused()).inDialog).toBe(true);
});
