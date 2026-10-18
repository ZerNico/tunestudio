import { Schema } from "effect";

/**
 * The third-party notices the build writes next to the renderer (`scripts/licenses`): every package bundled into the
 * app, the Rust crates and C/C++ libraries in the native addon, and Electron. Loaded only when someone asks to read
 * them, since the texts are large.
 */
export const NOTICES_PATH = "/licenses.json";

/** A library and the license it comes under; `text` is its index in `Notices.texts`. */
export const Notice = Schema.Struct({
  name: Schema.String,
  version: Schema.NullOr(Schema.String),
  /** An SPDX expression (`MIT OR Apache-2.0`), or a name for licenses SPDX has none for. */
  license: Schema.String,
  url: Schema.NullOr(Schema.String),
  text: Schema.Number,
});
export type Notice = typeof Notice.Type;

export const Notices = Schema.Struct({
  /** False on the dev server before anything was built: the lists are empty. */
  generated: Schema.Boolean,
  /** Packages bundled into the renderer and the main process. */
  javascript: Schema.Array(Notice),
  /** C and C++ libraries the native addon links or loads (ONNX Runtime, whisper.cpp, ...). */
  libraries: Schema.Array(Notice),
  /** Rust crates linked into the native addon. */
  crates: Schema.Array(Notice),
  electron: Schema.NullOr(Notice),
  /** The notice texts, each once: many crates share the same Apache text. */
  texts: Schema.Array(Schema.String),
});
export type Notices = typeof Notices.Type;

const decodeNotices = Schema.decodeUnknownPromise(Notices);

let loading: Promise<Notices> | undefined;

/** The build's notices, fetched once; a failed fetch is tried again next time. */
export function loadNotices(): Promise<Notices> {
  loading ??= fetch(NOTICES_PATH)
    .then((response) => {
      if (!response.ok) throw new Error(`The list of licenses is missing (${response.status}).`);
      return response.json() as Promise<unknown>;
    })
    .then(decodeNotices);
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

/** A program the app downloads when a feature first needs it. It isn't part of the app, so it has no text here. */
export interface DownloadedTool {
  name: string;
  license: string;
  url: string;
  about: string;
}

/** The download tools (`electron/tools/sources.ts`), with the license of the builds the app fetches. */
export const DOWNLOADED_TOOLS: readonly DownloadedTool[] = [
  {
    name: "yt-dlp",
    license: "Unlicense",
    url: "https://github.com/yt-dlp/yt-dlp",
    about: "Its builds include Python and other libraries under their own licenses.",
  },
  {
    name: "QuickJS-ng",
    license: "MIT",
    url: "https://github.com/quickjs-ng/quickjs",
    about: "Runs YouTube's checks for yt-dlp.",
  },
  {
    name: "FFmpeg for macOS",
    license: "GPL-3.0-or-later",
    url: "https://ffmpeg.martin-riedl.de",
    about: "Martin Riedl's builds. They include x264 and x265, so they come under the GPL.",
  },
  {
    name: "FFmpeg for Windows and Linux",
    license: "LGPL-3.0-or-later",
    url: "https://github.com/BtbN/FFmpeg-Builds",
    about: "BtbN's LGPL builds.",
  },
];

/** Whether a name or license contains `query`, ignoring case. */
export function matchesQuery(entry: { name: string; license: string }, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return true;
  return entry.name.toLowerCase().includes(wanted) || entry.license.toLowerCase().includes(wanted);
}
