/** Reading a macOS app bundle's `Info.plist`, for the program inside it and its identifier. */
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name] ?? whole;
  });
}

/**
 * The string values of an XML property list's top-level dictionary. Nested dictionaries and arrays are skipped, so a
 * key of the same name inside one (a document type's) doesn't count.
 */
export function plistStrings(xml: string): Map<string, string> {
  const values = new Map<string, string>();
  const tags = /<(\/?)([\w-]+)[^>]*?(\/?)>|([^<]+)/g;
  let depth = 0;
  let key: string | null = null;
  let reading: "key" | "string" | null = null;
  let text = "";
  for (const [, closing, name, selfClosing, chars] of xml.matchAll(tags)) {
    if (chars !== undefined) {
      if (reading) text += chars;
      continue;
    }
    if (name === "dict" || name === "array") {
      if (selfClosing) continue;
      depth += closing ? -1 : 1;
      key = null;
      continue;
    }
    if (depth !== 1) continue;
    if ((name === "key" || name === "string") && !closing && !selfClosing) {
      reading = name;
      text = "";
    } else if (name === "key" && closing) {
      key = decode(text);
      reading = null;
    } else if (name === "string" && (closing || selfClosing)) {
      if (key !== null) values.set(key, closing ? decode(text) : "");
      key = null;
      reading = null;
    } else if (!closing && name !== "plist" && name !== "?xml") {
      // Another kind of value (a number, true, data): the key has no string.
      key = null;
    }
  }
  return values;
}

/**
 * A bundle's `Contents/Info.plist` as its top-level strings; null when it has none or it can't be read. Binary
 * property lists are turned into JSON by macOS's own `plutil` (only macOS writes them).
 */
export function readInfoPlist(bundle: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const file = paths.join(bundle, "Contents", "Info.plist");
    const bytes = yield* fs.readFile(file);
    if (Buffer.from(bytes.subarray(0, 8)).toString("latin1") !== "bplist00") {
      return plistStrings(new TextDecoder().decode(bytes));
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const json = yield* spawner.string(ChildProcess.make("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]));
    const parsed = yield* Effect.try(() => JSON.parse(json) as Record<string, unknown>);
    return new Map(
      Object.entries(parsed).flatMap(([name, value]) => (typeof value === "string" ? [[name, value] as const] : [])),
    );
  }).pipe(Effect.orElseSucceed(() => null));
}
