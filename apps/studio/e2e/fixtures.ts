import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import type { ElectronApplication } from "@playwright/test";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A small solid-colour PNG, so covers really decode (thumbnails, `<img>` through `media://`). */
function png(size: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PNG = png(64, [92, 140, 70]);

/** Bytes standing in for audio: the app copies media as is and never decodes it here. */
function noise(size: number, seed: number): Buffer {
  const bytes = Buffer.alloc(size);
  let state = seed;
  for (let index = 0; index < size; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

export interface SongFixture {
  dir: string;
  folder: string;
  audio: Buffer;
  cover: Buffer;
  cleanup: () => void;
}

/** A synthetic UltraStar song folder (chart, audio, vocals, music, cover) in a temp folder. */
export function songFixture(): SongFixture {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tunestudio-e2e-song-")));
  const folder = path.join(dir, "Test Artist - Night Signals");
  fs.mkdirSync(folder);
  const audio = noise(1_500_000, 7);
  const chart = [
    "#TITLE:Night Signals",
    "#ARTIST:Test Artist",
    "#LANGUAGE:English",
    "#YEAR:2024",
    "#MP3:song.mp3",
    "#VOCALS:song [VOC].mp3",
    "#INSTRUMENTAL:song [INSTR].mp3",
    "#COVER:cover.png",
    "#BPM:240",
    "#GAP:1250",
    "#X-CUSTOM:kept",
    ": 0 4 2 Hel",
    ": 4 4 4 lo ",
    "* 8 8 7 world",
    "- 18",
    ": 20 4 0 good",
    ": 24 6 -3 bye",
    "E",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(folder, "song.txt"), chart);
  fs.writeFileSync(path.join(folder, "song.mp3"), audio);
  // Its own vocals and music: nothing to separate (tests have no models).
  fs.writeFileSync(path.join(folder, "song [VOC].mp3"), noise(200_000, 8));
  fs.writeFileSync(path.join(folder, "song [INSTR].mp3"), noise(200_000, 9));
  fs.writeFileSync(path.join(folder, "cover.png"), PNG);
  return { dir, folder, audio, cover: PNG, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A WAV file of silence, `seconds` long: audio that really plays (the fixture's own is random bytes). */
function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const size = rate * seconds * 2;
  const bytes = Buffer.alloc(44 + size);
  bytes.write("RIFF");
  bytes.writeUInt32LE(36 + size, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(size, 40);
  return bytes;
}

/** Gives the fixture song audio that plays (silence), for tests that need playback to run; before importing it. */
export function makePlayable(song: SongFixture) {
  for (const name of ["song.mp3", "song [VOC].mp3", "song [INSTR].mp3"])
    fs.writeFileSync(path.join(song.folder, name), silentWav(6));
}

/**
 * Runs in each page (main world): the page's own copy, cut and paste events (the keys' way on Windows and Linux, and
 * in tests everywhere, since Playwright's keys reach the page and not the Edit menu) would go to the system clipboard
 * through Chromium. The trusted event is stopped before the page's listeners see it and the same event is dispatched
 * again with a DataTransfer of its own: what the page copies goes to main's (stubbed) clipboard through the preload,
 * as the Edit menu's copy does, and a paste gets what the keys copied last. Text fields' own copy and paste still
 * reach Chromium (the tests don't use them).
 */
const PAGE_CLIPBOARD = `(() => {
  if (window.__e2eClipboard) return;
  const state = (window.__e2eClipboard = { text: "" });
  for (const type of ["copy", "cut", "paste"]) {
    window.addEventListener(type, (event) => {
      if (!event.isTrusted) return;
      event.stopImmediatePropagation();
      const data = new DataTransfer();
      if (type === "paste") data.setData("text/plain", state.text);
      const again = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true, composed: true });
      (event.target ?? document).dispatchEvent(again);
      if (type !== "paste" && again.defaultPrevented) {
        state.text = data.getData("text/plain");
        window.tunestudio?.clipboard?.({ write: state.text });
      }
    }, true);
  }
})()`;

/**
 * Replaces Electron's dialogs, clipboard and `shell.showItemInFolder` in the main process: dialogs answer
 * from a queue (`answerDialogs`), revealed paths are recorded (`revealedPaths`), and the clipboard is a string in main
 * (`clipboardText`), with every page's copy and paste events kept off the system clipboard too (`PAGE_CLIPBOARD`). No
 * native window ever opens and the system clipboard is never touched.
 */
export async function stubDesktop(app: ElectronApplication) {
  await app.evaluate(async ({ app: electronApp, clipboard, dialog, shell, webContents }, pageClipboard) => {
    const state = Object.assign(globalThis, {
      answers: [] as (string | null)[],
      revealed: [] as string[],
      clipboardText: "",
    });
    const next = () => state.answers.shift() ?? null;
    dialog.showOpenDialog = (async () => {
      const answer = next();
      return { canceled: answer === null, filePaths: answer === null ? [] : [answer] };
    }) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => {
      const answer = next();
      return { canceled: answer === null, filePath: answer ?? "" };
    }) as typeof dialog.showSaveDialog;
    shell.showItemInFolder = (target: string) => void state.revealed.push(target);
    clipboard.readText = async () => state.clipboardText;
    clipboard.writeText = async (text: string) => {
      state.clipboardText = text;
    };
    // Pages loaded from now on (new windows, reloads), and the ones already there.
    electronApp.on("web-contents-created", (_event, contents) => {
      contents.on("dom-ready", () => void contents.executeJavaScript(pageClipboard));
    });
    await Promise.all(webContents.getAllWebContents().map((contents) => contents.executeJavaScript(pageClipboard)));
  }, PAGE_CLIPBOARD);
}

/** The text on the (stubbed) clipboard, as main reads it. */
export function clipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

/** Queues the paths the next dialogs return (`null` cancels). */
export async function answerDialogs(app: ElectronApplication, ...answers: (string | null)[]) {
  await app.evaluate((_electron, values) => {
    (globalThis as typeof globalThis & { answers: (string | null)[] }).answers.push(...values);
  }, answers);
}

export function revealedPaths(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as typeof globalThis & { revealed: string[] }).revealed);
}

/**
 * A game for "Try in game": a shell script that writes the arguments it got to `argv.txt` in `folder` (one per line,
 * then what it saw of `ELECTRON_RUN_AS_NODE`) and keeps running for a few seconds, as a game would. On macOS it is
 * the program of an app bundle whose `Info.plist` names it; elsewhere the script itself (Windows isn't covered).
 */
export function fakeGame(folder: string, name: string, executable: string) {
  const argv = path.join(folder, "argv.txt");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$@" > "${argv}.part"`,
    `printf 'electron:%s\\n' "$ELECTRON_RUN_AS_NODE" >> "${argv}.part"`,
    `mv "${argv}.part" "${argv}"`,
    "sleep 4",
    "",
  ].join("\n");
  if (process.platform !== "darwin") {
    const program = path.join(folder, executable);
    fs.writeFileSync(program, script, { mode: 0o755 });
    return { app: program, argv };
  }
  const app = path.join(folder, `${name}.app`);
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents", "Info.plist"),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      "<dict>",
      `\t<key>CFBundleExecutable</key>\n\t<string>${executable}</string>`,
      "\t<key>CFBundleIdentifier</key>\n\t<string>org.example.fake-game</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(app, "Contents", "MacOS", executable), script, { mode: 0o755 });
  return { app, argv };
}
