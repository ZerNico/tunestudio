/**
 * A project's cover and background: replaced by a cover found online or an image file the user picked, or removed. The media go into the project like any other (named for export as `[CO]` and `[BG]`);
 * this isn't part of undo.
 */
import { eq } from "drizzle-orm";
import { Effect, FileSystem, Path } from "effect";

import type { ArtworkChoice } from "../../src/lib/native/contract";
import { ImageUnreadable, mapFileError } from "../errors";
import { COVER_HOSTS, Downloads, hostAllowed } from "../tools/downloads";
import { MOST_IMAGE_BYTES } from "../youtube/covers";
import { orDiskFull } from "./database";
import { imageExtension, readImage } from "./images";
import { listMedia, writeMedia } from "./media";
import type { ProjectSession } from "./projects";
import { media, song } from "./schema";

export type ArtworkRole = "cover" | "background";

const SUFFIX: Record<ArtworkRole, string> = { cover: " [CO]", background: " [BG]" };

/** Downloads a chosen cover into `folder`, named for what it is (JPEG or PNG), or null if that fails. */
export function downloadCover(url: string, folder: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const downloads = yield* Downloads;
    // The URL comes from the renderer: only the cover catalogs, not every host downloads may use.
    if (!URL.canParse(url) || !hostAllowed(new URL(url).hostname, COVER_HOSTS)) return null;
    const file = path.join(folder, "chosen-cover");
    yield* downloads.file(url, file, () => Effect.void, { hosts: COVER_HOSTS, maxBytes: MOST_IMAGE_BYTES });
    const bytes = yield* fs.readFile(file);
    const extension = imageExtension(bytes);
    if (!extension) return null;
    yield* fs.rename(file, `${file}${extension}`);
    return `${file}${extension}`;
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() => null),
  );
}

/** Replaces the project's cover or background with `choice` (or removes it). */
export function setArtwork(session: ProjectSession, role: ArtworkRole, choice: ArtworkChoice) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const folder = yield* fs
      .makeTempDirectoryScoped({ prefix: "tunestudio-artwork-" })
      .pipe(mapFileError("a temporary folder", "create"));
    let file: string | null = null;
    if (choice.kind === "found") {
      file = yield* downloadCover(choice.url, folder);
      if (!file) return yield* new ImageUnreadable({ message: "The cover couldn't be downloaded. Try another one." });
    } else if (choice.kind === "file") {
      const image = yield* readImage(choice.path);
      file = paths.join(folder, `chosen${image.extension}`);
      yield* fs.writeFile(file, image.bytes).pipe(mapFileError("the image", "save"));
    }
    const [details] = yield* session.db
      .select({ title: song.title, artist: song.artist })
      .from(song)
      .limit(1)
      .pipe(Effect.orDie);
    const name = details ? `${details.artist} - ${details.title}` : role;
    const old = (yield* listMedia(session.db)).filter((row) => row.role === role);
    if (file) {
      yield* writeMedia(session.db, {
        path: file,
        role,
        fileName: `${name}${SUFFIX[role]}${paths.extname(file)}`,
        source: "chosen",
      });
    }
    // The old one goes once the new one is in (its chunks go with it).
    for (const row of old) yield* session.db.delete(media).where(eq(media.id, row.id)).pipe(orDiskFull);
  }).pipe(Effect.scoped);
}
