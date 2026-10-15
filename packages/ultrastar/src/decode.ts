import { UltraStarError } from "./types";

function headers(text: string): [key: string, value: string][] {
  return text
    .replace(/^﻿/, "")
    .split(/\r\n|\n|\r/)
    .flatMap((raw) => {
      const match = /^#([^:]+):(.*)$/s.exec(raw.trimStart());
      return match ? [[match[1]!.trim().toUpperCase(), match[2]!] as [string, string]] : [];
    });
}

function encodingError(message: string): UltraStarError {
  return new UltraStarError(message, { code: "UNSUPPORTED_ENCODING" });
}

/**
 * The encoding the chart's `#ENCODING` headers declare, checked against the BOM. Labels like
 * `CP1252` and `UTF8` are accepted next to the WHATWG names.
 */
function declaredstring(text: string, bom?: string): string | undefined {
  let encoding: string | undefined;
  for (const [key, value] of headers(text)) {
    if (key !== "ENCODING") continue;
    let label = value
      .trim()
      .toLowerCase()
      .replace(/^cp[-_]?(125[0-8])$/, "windows-$1")
      .replace(/^utf[-_]?(8|16)(le|be)?$/, "utf-$1$2");
    if (label === "utf-16" && bom?.startsWith("utf-16")) label = bom;
    let candidate: string;
    try {
      candidate = new TextDecoder(label, { fatal: true }).encoding;
    } catch {
      throw encodingError(`The chart's encoding “${value.trim()}” isn't supported.`);
    }
    if (encoding && encoding !== candidate) throw encodingError("The chart declares two different encodings.");
    if (bom && candidate !== bom) throw encodingError("The chart's encoding header doesn't match its byte order mark.");
    if (!bom && candidate.startsWith("utf-16")) throw encodingError("A UTF-16 chart needs a byte order mark.");
    encoding = candidate;
  }
  return encoding;
}

function decodeStrict(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw encodingError(`The chart isn't valid ${encoding.toUpperCase()} text.`);
  }
}

/**
 * Decodes a chart file's bytes to text: a BOM wins (UTF-8, UTF-16 LE/BE), then a declared
 * `#ENCODING`, then UTF-8, and undeclared legacy charts that aren't valid UTF-8 fall back to
 * Windows-1252. Unsupported, conflicting or wrong declarations throw an `UltraStarError` with
 * the code `UNSUPPORTED_ENCODING`.
 */
export function decodeChart(bytes: Uint8Array): string {
  const bom =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
          ? "utf-8"
          : undefined;
  if (bom) {
    const text = decodeStrict(bytes, bom);
    declaredstring(text, bom);
    return text;
  }
  let utf8: string | undefined;
  try {
    utf8 = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: an undeclared legacy chart, read as Windows-1252 below.
  }
  // Header names are ASCII, so any single-byte reading finds the declaration.
  const encoding = declaredstring(utf8 ?? new TextDecoder("windows-1252").decode(bytes));
  if (!encoding) return utf8 ?? new TextDecoder("windows-1252").decode(bytes);
  const text = decodeStrict(bytes, encoding);
  if (declaredstring(text) !== encoding) {
    throw encodingError("The chart's encoding header doesn't match the text it decodes to.");
  }
  return text;
}
