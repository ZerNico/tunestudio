export type NoteType = "normal" | "golden" | "freestyle" | "rap" | "golden-rap";

export interface ChartNote {
  id: string;
  /** Absolute audio seconds, including GAP. */
  start: number;
  duration: number;
  /** MIDI semitones: C4 = 60, UltraStar pitch + 60. */
  pitch: number;
  /** Exact syllable, including leading/trailing whitespace. */
  lyric: string;
  type: NoteType;
  lineId: string;
  player?: number;
}

/** Optional display timing after a lyric line, in absolute audio seconds. */
export interface ChartLineBreak {
  lineId: string;
  start: number;
  end?: number;
}

export interface ChartDocument {
  version: 1;
  id: string;
  metadata: Record<string, string>;
  notes: ChartNote[];
  /** Preserves imported display timing. New/edited lines may omit this. */
  lineBreaks?: ChartLineBreak[];
}

export interface PitchFrame {
  time: number;
  midi: number;
  confidence: number;
}
export interface ParseResult {
  document: ChartDocument;
  warnings: string[];
}
export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  noteIds?: string[];
}

export const NOTE_TYPE_SYMBOLS: Record<NoteType, string> = {
  normal: ":",
  golden: "*",
  freestyle: "F",
  rap: "R",
  "golden-rap": "G",
};

let nextId = 0;
/** No Node/browser dependencies. IDs survive edits; file formats do not store them. */
export function createId(prefix = "note"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? `${Date.now().toString(36)}-${(++nextId).toString(36)}`}`;
}

export class UltraStarError extends Error {
  readonly line?: number;
  readonly code: string;

  constructor(message: string, options: { line?: number; code?: string } = {}) {
    super(options.line === undefined ? message : `Line ${options.line}: ${message}`);
    this.name = "UltraStarError";
    this.line = options.line;
    this.code = options.code ?? "INVALID_FORMAT";
  }
}

export class DocumentValidationError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(
      diagnostics
        .filter((item) => item.severity === "error")
        .map((item) => item.message)
        .join("\n"),
    );
    this.name = "DocumentValidationError";
    this.diagnostics = diagnostics;
  }
}

/** True for text that would break a chart record: a CR, LF or NUL character. */
export function breaksLine(text: string): boolean {
  return /[\r\n]/.test(text) || text.includes("\u0000");
}
