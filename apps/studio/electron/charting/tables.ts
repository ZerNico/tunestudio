/**
 * The generated tables in `data/` (aligner text, learned syllables): 1.2 MB of JSON. They aren't bundled, since every
 * launch would parse them and most never chart; the build copies them beside the main bundle (`dist-electron/data`,
 * `scripts/build-electron.ts`) and they are read the first time they are needed.
 */
import fs from "node:fs";
import path from "node:path";

/** Parses `data/<name>`, from the source folder in tests and from beside the bundle in the app. */
export function readTable(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "data", name), "utf8"));
}

/** `make`'s value, made on the first call and kept. */
export function lazy<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
}
