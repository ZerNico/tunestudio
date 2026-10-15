/**
 * What the start screen learns about a picked or dropped audio file: its name, size and kind
 * only. Nothing is read here; that is the import step's job.
 */

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav", "weba", "webm"]);

/** The `accept` list for the audio file picker. */
export const AUDIO_ACCEPT = [...AUDIO_EXTENSIONS].map((extension) => `.${extension}`).join(",");

export interface AudioFileSummary {
  name: string;
  size: number;
  /** Upper-case extension, e.g. "MP3". */
  format: string;
  /** Artist and title guessed from an "Artist - Title" file name. */
  artist: string;
  title: string;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isAudioFile(name: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionOf(name));
}

export function summarizeAudioFile(file: { name: string; size: number }): AudioFileSummary {
  const base = file.name.replace(/\.[^.]+$/, "");
  const [artist, ...rest] = base.split(/\s+[-–]\s+/);
  const title = rest.join(" - ");
  return {
    name: file.name,
    size: file.size,
    format: extensionOf(file.name).toUpperCase(),
    artist: title ? (artist ?? "") : "",
    title: title || base,
  };
}

/** What a dropped file starts: opening a project, importing a song chart, or an audio project. */
export function dropKind(name: string, isDirectory: boolean): "project" | "song" | "audio" | "unknown" {
  if (isDirectory) return "song";
  const extension = extensionOf(name);
  if (extension === "tunestudio") return "project";
  if (extension === "txt") return "song";
  return AUDIO_EXTENSIONS.has(extension) ? "audio" : "unknown";
}
