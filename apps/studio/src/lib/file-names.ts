/** Characters no file name may hold on one of the desktop platforms, besides control characters. */
const UNSAFE = new Set('\\/:*?"<>|');

function isUnsafe(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f || UNSAFE.has(char);
}

/** Windows reserves these names whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * `text` as a file or folder name that works on macOS, Windows and Linux: unsafe characters
 * become `_`, trailing dots and spaces go, and very long names are shortened.
 */
export function safeFileName(text: string, fallback = "Untitled"): string {
  let name = Array.from(text, (char) => (isUnsafe(char) ? "_" : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (name.length > 120) name = name.slice(0, 120).trimEnd();
  if (!name || RESERVED.test(name)) return fallback;
  return name;
}

/** `<Artist> - <Title>`, safe as a file name. */
export function songFileName(artist: string, title: string): string {
  return safeFileName(`${artist.trim() || "Unknown artist"} - ${title.trim() || "Untitled"}`);
}

/** The extension of `fileName` with its dot (`.mp3`), or "" without one. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot) : "";
}

/** The project's name: its file name without the folder and `.tunestudio`. */
export function projectName(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  return name.replace(/\.tunestudio$/i, "");
}

/**
 * What a project's file name says beyond its song, for telling projects of the same song apart:
 * nothing for `Artist - Title` or `Title`, the rest for `Artist - Title (Duet)`, else the whole name.
 */
export function projectNameExtra(path: string, artist: string, title: string): string | null {
  const name = projectName(path);
  const lower = name.toLowerCase();
  for (const plain of [songFileName(artist, title), safeFileName(title)]) {
    if (lower.startsWith(plain.toLowerCase())) return name.slice(plain.length).trim() || null;
  }
  return name;
}
