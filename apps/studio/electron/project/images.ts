import { Effect, FileSystem } from "effect";

import { ImageUnreadable, mapFileError, quoted } from "../errors";

/** Covers bigger than this aren't photos of an album; they would only bloat the project. */
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

/** `.jpg` or `.png` by the file's first bytes, or null for anything else. */
export function imageExtension(bytes: Uint8Array): ".jpg" | ".png" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ".png";
  return null;
}

/** Reads a JPEG or PNG image the user picked; anything else, or a huge file, is refused. */
export function readImage(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const name = quoted(path.split(/[\\/]/).at(-1) ?? path);
    const info = yield* fs.stat(path).pipe(mapFileError(name, "read"));
    if (info.type !== "File" || Number(info.size) > MAX_IMAGE_SIZE) {
      return yield* new ImageUnreadable({ message: `${name} is too big for a cover. Choose an image under 20 MB.` });
    }
    const bytes = yield* fs.readFile(path).pipe(mapFileError(name, "read"));
    const extension = imageExtension(bytes);
    if (!extension) {
      return yield* new ImageUnreadable({ message: `${name} isn't a JPEG or PNG image.` });
    }
    return { bytes, extension };
  });
}
