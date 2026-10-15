import { gridFromMetadata, quantizeNoteTiming, secondsToTicks, ticksToSeconds, type ChartGrid } from "./grid";
import {
  createId,
  DocumentValidationError,
  NOTE_TYPE_SYMBOLS,
  UltraStarError,
  type ChartDocument,
  type ChartLineBreak,
  type ChartNote,
  type NoteType,
  type ParseResult,
} from "./types";
import { isRelativeModeUnsupported, validateDocument } from "./validation";

const SYMBOL_TYPES: Record<string, NoteType> = {
  ":": "normal",
  "*": "golden",
  F: "freestyle",
  R: "rap",
  G: "golden-rap",
};

function integer(raw: string, label: string, line: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new UltraStarError(`${label} must be a safe integer.`, { line });
  return value;
}

/** Absolute UltraStar TXT only. Rejects relative timing, ambiguous P3 and unknown body records. */
export function parseUltraStar(text: string): ParseResult {
  if (typeof text !== "string") throw new UltraStarError("Chart input must be text.");
  const metadata: Record<string, string> = {};
  const notes: ChartNote[] = [];
  const lineBreaks: ChartLineBreak[] = [];
  const warnings: string[] = [];
  const documentId = createId("chart");
  const tracks = new Map<number, { lineId: string; hasNotes: boolean; lastStart?: number }>();
  let player = 1;
  let explicitPlayers = false;
  let inBody = false;
  let ended = false;
  let grid: ChartGrid | undefined;
  const track = () => {
    let state = tracks.get(player);
    if (!state) {
      state = { lineId: createId("line"), hasNotes: false };
      tracks.set(player, state);
    }
    return state;
  };
  const source = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  for (let index = 0; index < source.length; index++) {
    const lineNumber = index + 1;
    const raw = source[index]!;
    if (raw.includes("\u0000"))
      throw new UltraStarError("NUL character in input; decode the file as text (UTF-8 or its original encoding).", {
        line: lineNumber,
      });
    const line = raw.trimStart();
    if (!line.trim()) continue;
    if (ended)
      throw new UltraStarError(
        "Unexpected content after E; multiple charts or per-track end markers are unsupported.",
        { line: lineNumber },
      );
    if (line.startsWith("#")) {
      if (inBody) throw new UltraStarError("Headers must precede notes and player records.", { line: lineNumber });
      const match = /^#([^:]+):(.*)$/s.exec(line);
      if (!match) throw new UltraStarError("Malformed header; expected #NAME:value.", { line: lineNumber });
      const key = match[1]!.trim().toUpperCase();
      if (!/^[A-Z0-9_][A-Z0-9_-]*$/.test(key)) throw new UltraStarError("Invalid header name.", { line: lineNumber });
      if (Object.prototype.hasOwnProperty.call(metadata, key)) {
        if (metadata[key] !== match[2])
          throw new UltraStarError(`Conflicting duplicate #${key} header; choose one value before importing.`, {
            line: lineNumber,
          });
        warnings.push(`Line ${lineNumber}: duplicate #${key} header retained once.`);
      }
      metadata[key] = match[2]!;
      if (key === "RELATIVE" && isRelativeModeUnsupported(metadata)) {
        throw new UltraStarError(
          "Relative timing (#RELATIVE) is unsupported; convert the chart to absolute timing first.",
          { line: lineNumber, code: "UNSUPPORTED_RELATIVE" },
        );
      }
      continue;
    }
    if (!grid) {
      try {
        grid = gridFromMetadata(metadata);
      } catch (error) {
        throw new UltraStarError(error instanceof Error ? error.message : "Invalid BPM/GAP.", {
          line: lineNumber,
          code: "INVALID_GRID",
        });
      }
    }
    inBody = true;
    if (/^E[ \t]*$/.test(line)) {
      ended = true;
      continue;
    }
    if (line.startsWith("P")) {
      const match = /^P[ \t]*([12])[ \t]*$/.exec(line);
      if (!match)
        throw new UltraStarError(
          "Only P1 and P2 tracks are supported. P3/both-player and other duet constructs must be expanded into separate tracks first.",
          { line: lineNumber, code: "UNSUPPORTED_PLAYER" },
        );
      if (!explicitPlayers && notes.length) {
        warnings.push(`Line ${lineNumber}: notes preceding the first player marker were assigned to player 1.`);
        for (const note of notes) note.player = 1;
      }
      explicitPlayers = true;
      player = Number(match[1]);
      track();
      continue;
    }
    if (line.startsWith("-")) {
      const match = /^-[ \t]+([+-]?\d+)(?:[ \t]+([+-]?\d+))?[ \t]*$/.exec(line);
      if (!match)
        throw new UltraStarError("Malformed line break; expected - <tick> or - <tick> <end-tick>.", {
          line: lineNumber,
        });
      const start = integer(match[1]!, "Line break tick", lineNumber);
      const end = match[2] === undefined ? undefined : integer(match[2]!, "Line break end tick", lineNumber);
      if (end !== undefined && end < start)
        throw new UltraStarError("Line break end precedes its start.", { line: lineNumber });
      const state = track();
      if (!state.hasNotes)
        warnings.push(
          `Line ${lineNumber}: display break after an empty line omitted; the document model has no empty lyric lines.`,
        );
      else {
        lineBreaks.push({
          lineId: state.lineId,
          start: ticksToSeconds(start, grid),
          ...(end === undefined ? {} : { end: ticksToSeconds(end, grid) }),
        });
        state.lineId = createId("line");
        state.hasNotes = false;
      }
      continue;
    }
    const match = /^([:*FRG])[ \t]+([+-]?\d+)[ \t]+([+-]?\d+)[ \t]+([+-]?\d+)(?:[ \t](.*))?$/s.exec(line);
    if (!match)
      throw new UltraStarError(
        `Unsupported or malformed record ${JSON.stringify(line.slice(0, 70))}. Expected :, *, F, R, G, -, P1/P2 or E.`,
        { line: lineNumber, code: "UNSUPPORTED_RECORD" },
      );
    const start = integer(match[2]!, "Note start", lineNumber);
    const length = integer(match[3]!, "Note length", lineNumber);
    const pitch = integer(match[4]!, "Note pitch", lineNumber) + 60;
    if (length <= 0) throw new UltraStarError("Note length must be greater than zero.", { line: lineNumber });
    if (!Number.isSafeInteger(pitch) || !Number.isSafeInteger(start + length))
      throw new UltraStarError("Note pitch or end exceeds the safe integer range.", { line: lineNumber });
    const state = track();
    if (state.lastStart !== undefined && start < state.lastStart)
      warnings.push(
        `Line ${lineNumber}: player ${player} notes are out of chronological order; export sorts them within their track.`,
      );
    const startSeconds = ticksToSeconds(start, grid);
    // Convert shared tick boundaries identically instead of accumulating a rounded duration.
    const endSeconds = ticksToSeconds(start + length, grid);
    notes.push({
      id: createId("note"),
      start: startSeconds,
      duration: endSeconds - startSeconds,
      pitch,
      lyric: match[5] ?? "",
      type: SYMBOL_TYPES[match[1]!]!,
      lineId: state.lineId,
      ...(explicitPlayers ? { player } : {}),
    });
    state.hasNotes = true;
    state.lastStart = start;
  }
  const document: ChartDocument = {
    version: 1,
    id: documentId,
    metadata,
    notes,
    ...(lineBreaks.length ? { lineBreaks } : {}),
  };
  const diagnostics = validateDocument(document);
  if (diagnostics.some((item) => item.severity === "error")) throw new DocumentValidationError(diagnostics);
  if (!ended) warnings.push("Missing E end marker; one will be added on export.");
  if (metadata.GAP === undefined) warnings.push("Missing GAP header; using 0 milliseconds.");
  if (text.includes("�"))
    warnings.push(
      "Input contains Unicode replacement characters (�). Check the original file encoding; damaged text cannot be recovered by the parser.",
    );
  if (explicitPlayers) {
    for (const number of tracks.keys()) {
      if (!notes.some((note) => note.player === number))
        warnings.push(`Player ${number} has no notes; its empty track marker will be omitted on export.`);
    }
  }
  warnings.push(...diagnostics.filter((item) => item.severity === "warning").map((item) => item.message));
  return { document, warnings };
}

export interface SerializeResult {
  text: string;
  warnings: string[];
}

/** Export is a grid projection, never a mutation of the document's precise seconds. */
export function serializeUltraStarWithDiagnostics(document: ChartDocument): SerializeResult {
  const diagnostics = validateDocument(document);
  if (diagnostics.some((item) => item.severity === "error")) throw new DocumentValidationError(diagnostics);
  const warnings = diagnostics.filter((item) => item.severity === "warning").map((item) => item.message);
  const grid = gridFromMetadata(document.metadata);
  const output = Object.entries(document.metadata).map(
    ([key, value]) => `#${key}:${key === "ENCODING" ? "UTF8" : value}`,
  );
  const breaks = new Map(document.lineBreaks?.map((lineBreak) => [lineBreak.lineId, lineBreak]));
  const players = [...new Set(document.notes.map((note) => note.player ?? 1))].toSorted((a, b) => a - b);
  const explicitPlayers = document.notes.some((note) => note.player !== undefined);
  const breakTick = (seconds: number) => {
    const tick = Math.round(secondsToTicks(seconds, grid));
    if (!Number.isSafeInteger(tick)) throw new UltraStarError("Line break exceeds the safe integer tick range.");
    return tick;
  };
  for (const player of players) {
    if (explicitPlayers) output.push(`P${player}`);
    const notes = document.notes.filter((note) => (note.player ?? 1) === player).toSorted((a, b) => a.start - b.start);
    const lines: ChartNote[][] = [];
    for (const note of notes) {
      const current = lines[lines.length - 1];
      if (!current || current[0]!.lineId !== note.lineId) lines.push([note]);
      else current.push(note);
    }
    for (const [index, line] of lines.entries()) {
      let lastEnd = -Infinity;
      for (const note of line) {
        const timing = quantizeNoteTiming(note.start, note.duration, grid);
        lastEnd = Math.max(lastEnd, timing.start + timing.duration);
        output.push(
          `${NOTE_TYPE_SYMBOLS[note.type]} ${timing.start} ${timing.duration} ${note.pitch - 60} ${note.lyric}`,
        );
      }
      const saved = breaks.get(line[0]!.lineId);
      const next = lines[index + 1];
      const nextStart = next ? quantizeNoteTiming(next[0]!.start, next[0]!.duration, grid).start : undefined;
      if (saved) {
        const start = breakTick(saved.start);
        const end = saved.end === undefined ? undefined : breakTick(saved.end);
        output.push(`- ${start}${end === undefined ? "" : ` ${end}`}`);
      } else if (nextStart !== undefined) output.push(`- ${Math.min(lastEnd, nextStart)}`);
    }
  }
  output.push("E");
  return { text: `${output.join("\n")}\n`, warnings };
}

export function serializeUltraStar(document: ChartDocument): string {
  return serializeUltraStarWithDiagnostics(document).text;
}
