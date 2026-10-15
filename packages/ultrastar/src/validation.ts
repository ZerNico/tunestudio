import { gridFromMetadata, quantizeNoteTiming, secondsToTicks, ticksToSeconds, type ChartGrid } from "./grid";
import {
  breaksLine,
  DocumentValidationError,
  NOTE_TYPE_SYMBOLS,
  type ChartDocument,
  type ChartNote,
  type Diagnostic,
} from "./types";

export function isRelativeModeUnsupported(metadata: Record<string, string>): boolean {
  return metadata.RELATIVE !== undefined && !/^(?:NO|FALSE|0)$/i.test(metadata.RELATIVE.trim());
}

/** Collects diagnostics instead of throwing, including for malformed JSON at runtime. */
export function validateDocument(document: ChartDocument): Diagnostic[] {
  const result: Diagnostic[] = [];
  const add = (severity: Diagnostic["severity"], message: string, noteIds?: string[]) => {
    result.push({ severity, message, ...(noteIds ? { noteIds } : {}) });
  };
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return [{ severity: "error", message: "Document must be an object." }];
  }
  if (document.version !== 1) add("error", "Unsupported document version; expected version 1.");
  if (typeof document.id !== "string" || !document.id.trim()) add("error", "Document ID must be a non-empty string.");
  let grid: ChartGrid | undefined;
  if (!document.metadata || typeof document.metadata !== "object" || Array.isArray(document.metadata)) {
    add("error", "Metadata must be an object containing string header values.");
  } else {
    for (const [key, value] of Object.entries(document.metadata)) {
      if (!/^[A-Z0-9_][A-Z0-9_-]*$/.test(key))
        add("error", `Invalid header name ${JSON.stringify(key)}; use uppercase names.`);
      if (typeof value !== "string" || breaksLine(value))
        add("error", `Header ${key} must be a single-line string without NUL characters.`);
    }
    if (Object.values(document.metadata).every((value) => typeof value === "string")) {
      if (isRelativeModeUnsupported(document.metadata))
        add(
          "error",
          "Relative timing (#RELATIVE) is unsupported; convert the chart to absolute timing before importing.",
        );
      if (document.metadata.ENCODING !== undefined && document.metadata.ENCODING !== "UTF8")
        add(
          "warning",
          "ENCODING will be normalized to UTF8 on export. Save exported text as UTF-8; input must already be decoded correctly.",
        );
      try {
        grid = gridFromMetadata(document.metadata);
      } catch (error) {
        add("error", error instanceof Error ? error.message : "Invalid BPM/GAP.");
      }
      for (const key of ["TITLE", "ARTIST"]) {
        if (!document.metadata[key]?.trim()) add("warning", `Missing ${key} header.`);
      }
    }
  }
  if (!Array.isArray(document.notes)) {
    add("error", "Notes must be an array.");
    return result;
  }
  if (!document.notes.length) add("warning", "The chart has no notes.");
  const ids = new Set<string>();
  const tracks = new Map<number, ChartNote[]>();
  const lines = new Map<string, number>();
  const quantizedIds: string[] = [];
  let implicit = false;
  let explicit = false;
  for (const [index, note] of document.notes.entries()) {
    if (!note || typeof note !== "object" || Array.isArray(note)) {
      add("error", `Note ${index + 1} must be an object.`);
      continue;
    }
    const validId = typeof note.id === "string" && Boolean(note.id.trim());
    const validLineId = typeof note.lineId === "string" && Boolean(note.lineId.trim());
    const validPlayer = note.player === undefined || note.player === 1 || note.player === 2;
    const noteIds = validId ? [note.id] : undefined;
    const label = validId ? `Note ${note.id}` : `Note ${index + 1}`;
    if (!validId) add("error", `${label}: ID must be a non-empty string.`, noteIds);
    else if (ids.has(note.id)) add("error", `${label}: duplicate note ID.`, noteIds);
    else ids.add(note.id);
    if (!validLineId) add("error", `${label}: line ID must be a non-empty string.`, noteIds);
    const validStart = Number.isFinite(note.start);
    const validDuration = Number.isFinite(note.duration) && note.duration > 0;
    const validTiming =
      validStart &&
      validDuration &&
      Number.isFinite(note.start + note.duration) &&
      note.start + note.duration !== note.start;
    if (!validStart) add("error", `${label}: start must be finite seconds.`, noteIds);
    else if (note.start < 0) add("warning", `${label}: starts before audio zero; playback may truncate it.`, noteIds);
    if (!validDuration || (validStart && !validTiming)) {
      add("error", `${label}: duration must be positive, finite, and representable at this start time.`, noteIds);
    }
    if (!Number.isSafeInteger(note.pitch) || !Number.isSafeInteger(note.pitch - 60))
      add("error", `${label}: pitch must be a safe integer in MIDI semitones.`, noteIds);
    else if (note.pitch < 0 || note.pitch > 127)
      add(
        "warning",
        `${label}: pitch is outside the usual MIDI range 0–127; it will be retained, not clamped.`,
        noteIds,
      );
    if (typeof note.lyric !== "string" || breaksLine(note.lyric))
      add("error", `${label}: lyric must be a single-line string without NUL characters.`, noteIds);
    if (typeof note.type !== "string" || !Object.prototype.hasOwnProperty.call(NOTE_TYPE_SYMBOLS, note.type)) {
      const description =
        typeof note.type === "string"
          ? JSON.stringify(note.type)
          : Array.isArray(note.type)
            ? "array"
            : note.type === null
              ? "null"
              : typeof note.type;
      add("error", `${label}: unsupported note type ${description}; expected a supported string.`, noteIds);
    }
    if (!validPlayer)
      add("error", `${label}: only player tracks 1 and 2 are supported; P3/both-player mode is ambiguous.`, noteIds);
    if (note.player === undefined) implicit = true;
    else explicit = true;
    const player = note.player ?? 1;
    if (validLineId && validPlayer) {
      const linePlayer = lines.get(note.lineId);
      if (linePlayer !== undefined && linePlayer !== player)
        add("error", `${label}: line ID ${note.lineId} is shared by different player tracks.`, noteIds);
      lines.set(note.lineId, player);
    }
    if (validTiming) {
      // Only safe identifiers/players enter aggregation and its diagnostic messages.
      if (validId && validLineId && validPlayer) {
        const track = tracks.get(player) ?? [];
        track.push(note);
        tracks.set(player, track);
      }
      if (grid) {
        try {
          const timing = quantizeNoteTiming(note.start, note.duration, grid);
          const start = ticksToSeconds(timing.start, grid);
          const duration = timing.duration * (15 / grid.bpm);
          if (validId && (Math.abs(start - note.start) > 1e-8 || Math.abs(duration - note.duration) > 1e-8))
            quantizedIds.push(note.id);
        } catch (error) {
          add("error", `${label}: ${error instanceof Error ? error.message : "Invalid timing."}`, noteIds);
        }
      }
    }
  }
  if (implicit && explicit)
    add("warning", "Notes without a player are treated as player 1 when exported alongside explicit tracks.");
  if (quantizedIds.length)
    add(
      "warning",
      `${quantizedIds.length} note(s) will be rounded to the BPM tick grid on export (minimum duration: one tick). Internal seconds remain unchanged.`,
      quantizedIds,
    );
  const lineEnds = new Map<string, number>();
  const nextLineStarts = new Map<string, number>();
  for (const [player, track] of tracks) {
    track.sort((a, b) => a.start - b.start);
    const closed = new Set<string>();
    let currentLine: string | undefined;
    let active: ChartNote | undefined;
    for (const note of track) {
      lineEnds.set(note.lineId, Math.max(lineEnds.get(note.lineId) ?? -Infinity, note.start + note.duration));
      if (note.lineId !== currentLine) {
        if (currentLine !== undefined) {
          closed.add(currentLine);
          nextLineStarts.set(currentLine, note.start);
        }
        if (closed.has(note.lineId))
          add(
            "error",
            `Player ${player}: line ${note.lineId} is interleaved with another line. Reassign the moved notes to consecutive lyric lines before exporting.`,
            [note.id],
          );
        currentLine = note.lineId;
      }
      if (active && note.start < active.start + active.duration - 1e-8)
        add("warning", `Player ${player}: overlapping notes ${active.id} and ${note.id}.`, [active.id, note.id]);
      if (!active || note.start + note.duration > active.start + active.duration) active = note;
    }
  }
  if (document.lineBreaks !== undefined) {
    if (!Array.isArray(document.lineBreaks)) add("error", "Line breaks must be an array.");
    else {
      const seen = new Set<string>();
      for (const lineBreak of document.lineBreaks) {
        if (!lineBreak || typeof lineBreak !== "object" || Array.isArray(lineBreak)) {
          add("error", "Each line break must be an object.");
          continue;
        }
        if (typeof lineBreak.lineId !== "string" || !lineBreak.lineId.trim()) {
          add("error", "Line break must refer to a non-empty line ID.");
          continue;
        }
        if (seen.has(lineBreak.lineId)) add("error", `Duplicate display break for line ${lineBreak.lineId}.`);
        seen.add(lineBreak.lineId);
        if (!lines.has(lineBreak.lineId))
          add("warning", `Display break for removed/empty line ${lineBreak.lineId} will be omitted.`);
        if (
          !Number.isFinite(lineBreak.start) ||
          (lineBreak.end !== undefined && (!Number.isFinite(lineBreak.end) || lineBreak.end < lineBreak.start))
        ) {
          add("error", `Display break for line ${lineBreak.lineId} must have finite, ordered times.`);
          continue;
        }
        const lineEnd = lineEnds.get(lineBreak.lineId);
        const nextStart = nextLineStarts.get(lineBreak.lineId);
        if (
          lineEnd !== undefined &&
          (lineBreak.start < lineEnd - 1e-8 ||
            (nextStart !== undefined && (lineBreak.end ?? lineBreak.start) > nextStart + 1e-8))
        ) {
          add(
            "warning",
            `Display break for line ${lineBreak.lineId} is outside the gap between lyric lines; imported timing retained. Remove or adjust its lineBreaks entry if notes moved.`,
          );
        }
        if (grid) {
          try {
            const times = [lineBreak.start, ...(lineBreak.end === undefined ? [] : [lineBreak.end])];
            const ticks = times.map((time) => secondsToTicks(time, grid));
            if (ticks.some((tick) => !Number.isSafeInteger(Math.round(tick))))
              add("error", `Display break for line ${lineBreak.lineId} exceeds the safe integer tick range.`);
            else if (ticks.some((tick) => Math.abs(tick - Math.round(tick)) > 1e-7))
              add(
                "warning",
                `Display break for line ${lineBreak.lineId} will be rounded to the BPM tick grid on export.`,
              );
          } catch (error) {
            add("error", `Display break: ${error instanceof Error ? error.message : "invalid timing."}`);
          }
        }
      }
    }
  }
  return result;
}

export function assertValidDocument(document: ChartDocument): void {
  const diagnostics = validateDocument(document);
  if (diagnostics.some((item) => item.severity === "error")) throw new DocumentValidationError(diagnostics);
}
