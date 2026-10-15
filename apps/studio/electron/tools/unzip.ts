import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { crc32, inflateRaw } from "node:zlib";

const inflate = promisify(inflateRaw);

/** Whether `bytes` start like a zip file. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Signatures of the zip records read here. */
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/** Limits far above any tool download (FFmpeg unpacks to a few hundred MB), so a broken or hostile zip can't fill the disk. */
const MOST_BYTES = 2 * 1024 ** 3;
const MOST_ENTRIES = 50_000;

/** One file, folder or symlink the zip's directory lists. */
interface Entry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Unix file type and mode, when made on Unix. */
  unix: number;
  offset: number;
}

/** The zip's directory: every entry, checked against the limits before anything is unpacked. */
function directory(zip: Buffer): Entry[] {
  // The end-of-directory record sits in the last 64 KiB (after an optional comment).
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip file.");
  const count = zip.readUInt16LE(end + 10);
  if (zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0 || zip.readUInt16LE(end + 8) !== count) {
    throw new Error("Zip files split into parts aren't supported.");
  }
  if (count > MOST_ENTRIES) throw new Error("The zip file has too many entries.");

  const entries: Entry[] = [];
  let total = 0;
  let at = zip.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error("The zip file's directory is damaged.");
    if (zip.readUInt16LE(at + 8) & 1) throw new Error("Encrypted zip files aren't supported.");
    const nameLength = zip.readUInt16LE(at + 28);
    if (at + 46 + nameLength > zip.length) throw new Error("The zip file's directory is damaged.");
    const entry: Entry = {
      name: zip.toString("utf8", at + 46, at + 46 + nameLength),
      method: zip.readUInt16LE(at + 10),
      crc: zip.readUInt32LE(at + 16),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      // Zips made on Unix keep the file type and mode in the upper half of the external attributes.
      unix: zip.readUInt16LE(at + 4) >> 8 === 3 ? zip.readUInt32LE(at + 38) >>> 16 : 0,
      offset: zip.readUInt32LE(at + 42),
    };
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff) {
      throw new Error("Zip64 files aren't supported.");
    }
    total += entry.size;
    if (total > MOST_BYTES) throw new Error("The zip file unpacks to more than 2 GB.");
    entries.push(entry);
  }
  return entries;
}

/** An entry's content, checked against its recorded size and CRC. */
async function content(zip: Buffer, entry: Entry): Promise<Buffer> {
  if (zip.readUInt32LE(entry.offset) !== LOCAL_HEADER) throw new Error("The zip file is damaged.");
  const start = entry.offset + 30 + zip.readUInt16LE(entry.offset + 26) + zip.readUInt16LE(entry.offset + 28);
  if (start + entry.compressedSize > zip.length) throw new Error("The zip file is damaged.");
  const stored = zip.subarray(start, start + entry.compressedSize);
  let bytes: Buffer;
  if (entry.method === 0) bytes = stored;
  // One byte more than recorded is enough to notice a lie without inflating a bomb.
  else if (entry.method === 8) bytes = await inflate(stored, { maxOutputLength: entry.size + 1 });
  else throw new Error(`Unsupported compression in the zip file: ${entry.method}`);
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) throw new Error("The zip file is damaged.");
  return bytes;
}

/** Device names Windows reserves in every folder ("NUL", "com1.txt"), after its trailing dots and spaces go. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i;

/** A name as a case- and accent-insensitive file system sees it (macOS and Windows by default). */
const folded = (name: string) => name.normalize("NFC").toLowerCase();

/** Whether an entry is a symlink (its content is the target). */
const isLink = (entry: Entry) => (entry.unix & 0o170000) === 0o120000;

/** Whether `target` is `root` or inside it. */
function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Unpacks the zip file `file` into the new, empty `folder`, keeping the Unix permissions it
 * records (yt-dlp's executable). Our own reader, since Linux's tar can't read zip files: stored
 * and deflated entries, no Zip64 or encryption (tool downloads are far below 4 GB). Throws on
 * anything it can't read, on content that doesn't match its CRC, and on entries or symlinks that
 * would land outside `folder`.
 */
export async function unzip(file: string, folder: string): Promise<void> {
  if ((await fs.stat(file)).size > MOST_BYTES) throw new Error("The zip file is larger than 2 GB.");
  const zip = await fs.readFile(file);
  const root = path.resolve(folder);
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  const entries = directory(zip);

  // Folded: on macOS and Windows "A" and "a" are the same path, so a link named one way is reached the other way too.
  const links = new Set(entries.filter(isLink).map((entry) => folded(path.resolve(root, entry.name))));
  const resolved = entries.map((entry) => {
    const target = path.resolve(root, entry.name);
    const unsafe =
      !inside(root, target) ||
      // Windows' separator, alternate data streams ("a:b") and device names.
      /[\\:]/.test(entry.name) ||
      entry.name.split("/").some((segment) => RESERVED.test(segment.replace(/[. ]+$/, ""))) ||
      // Electron reads into .asar archives as if they were folders.
      /\.asar(\/|$)/i.test(entry.name);
    if (unsafe) throw new Error(`Unsafe path in the zip file: ${entry.name}`);
    // Nothing is unpacked through a symlink: with that, every path's real location is the one checked here.
    for (let parent = path.dirname(target); inside(root, parent) && parent !== root; parent = path.dirname(parent)) {
      if (links.has(folded(parent))) throw new Error(`Unsafe path in the zip file: ${entry.name}`);
    }
    return { entry, target };
  });

  for (const { entry, target } of resolved) {
    if (isLink(entry)) continue;
    if (entry.name.endsWith("/")) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }
    const bytes = await content(zip, entry);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const mode = entry.unix & 0o777;
    // `wx`: a name listed twice can't overwrite what was unpacked first.
    await fs.writeFile(target, bytes, { flag: "wx", ...(mode ? { mode } : {}) });
  }

  // Symlinks (macOS app bundles have them) come last, so nothing is written through one. A
  // target may only climb with leading "..": then, followed from the link's real folder, it
  // stays inside, and any symlink it passes through was checked the same way.
  for (const { entry, target } of resolved) {
    if (!isLink(entry)) continue;
    const link = (await content(zip, entry)).toString("utf8");
    // Checked as written, not normalized: the system resolves "a/../x" through "a", even when "a" is a symlink.
    const segments = link.split("/");
    const climbs = segments.findIndex((segment) => segment !== "..");
    const unsafe =
      !link ||
      path.isAbsolute(link) ||
      link.startsWith("/") ||
      link.includes("\\") ||
      /^[a-z]:/i.test(link) ||
      (climbs >= 0 && segments.slice(climbs).includes(".."));
    if (unsafe || !inside(root, path.resolve(path.dirname(target), link))) {
      throw new Error(`Unsafe link in the zip file: ${entry.name}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    // The folder really is where it was checked, not reached through another link under another
    // spelling (case, accents, Windows' "a." for "a", short names).
    const real = await fs.realpath(path.dirname(target));
    if (real !== path.join(realRoot, path.relative(root, path.dirname(target)))) {
      throw new Error(`Unsafe link in the zip file: ${entry.name}`);
    }
    await fs.symlink(link, target);
  }
}
