import fs from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

/** Whether `bytes` start like a zip file. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Signatures of the zip records read here. */
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/**
 * Unpacks the zip file `file` into `folder`, keeping the Unix permissions it records (yt-dlp's
 * executable). Our own reader, since Linux's tar can't read zip files: stored and deflated
 * entries, no Zip64 (tool downloads are far below 4 GB). Throws on anything it can't read, and
 * on entries that would land outside `folder`.
 */
export async function unzip(file: string, folder: string): Promise<void> {
  const zip = await fs.readFile(file);
  const root = path.resolve(folder);

  // The end-of-directory record sits in the last 64 KiB (after an optional comment).
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip file.");
  const entries = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);

  for (let index = 0; index < entries; index++) {
    if (zip.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new Error("The zip file's directory is damaged.");
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const madeBy = zip.readUInt16LE(at + 4) >> 8;
    const attributes = zip.readUInt32LE(at + 38);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new Error("Zip64 files aren't supported.");
    }

    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Unsafe path in the zip file: ${name}`);
    if (name.endsWith("/")) {
      await fs.mkdir(target, { recursive: true });
      continue;
    }

    if (zip.readUInt32LE(offset) !== LOCAL_HEADER) throw new Error("The zip file is damaged.");
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const stored = zip.subarray(start, start + compressedSize);
    const bytes = method === 0 ? stored : method === 8 ? inflateRawSync(stored) : null;
    if (!bytes) throw new Error(`Unsupported compression in the zip file: ${method}`);
    if (bytes.length !== size) throw new Error("The zip file is damaged.");

    // Zips made on Unix keep the file type and mode in the upper half of the external attributes.
    const unix = madeBy === 3 ? attributes >>> 16 : 0;
    await fs.mkdir(path.dirname(target), { recursive: true });
    if ((unix & 0o170000) === 0o120000) {
      // A symlink (macOS app bundles have them); its target is the entry's content.
      const link = bytes.toString("utf8");
      const resolved = path.resolve(path.dirname(target), link);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(`Unsafe link in the zip file: ${name}`);
      }
      await fs.symlink(link, target);
      continue;
    }
    const mode = unix & 0o777;
    await fs.writeFile(target, bytes, mode ? { mode } : {});
  }
}
