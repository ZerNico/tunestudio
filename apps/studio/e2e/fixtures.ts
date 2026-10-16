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

/**
 * Replaces Electron's dialogs and `shell.showItemInFolder` in the main process: dialogs answer
 * from a queue (`answerDialogs`), revealed paths are recorded (`revealedPaths`). No native
 * window ever opens.
 */
export async function stubDesktop(app: ElectronApplication) {
  await app.evaluate(({ dialog, shell }) => {
    const state = Object.assign(globalThis, { answers: [] as (string | null)[], revealed: [] as string[] });
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
  });
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
