import {
  defaultSwitch,
  gridFromMetadata,
  quantizeNoteTiming,
  secondsToTicks,
  tickDuration,
  ticksToSeconds,
  type ChartGrid,
} from "./grid";
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

/**
 * A P3 part (both singers) as copies in P1 and P2, each with its own lines and breaks, in place of the P3 notes. A
 * P3 line that overlaps a line of P1 or P2 in time would interleave with it, so it is refused.
 */
function singBoth(notes: ChartNote[], lineBreaks: ChartLineBreak[]) {
  const spans = new Map<string, { player: number; start: number; end: number }>();
  for (const note of notes) {
    const span = spans.get(note.lineId);
    if (!span) spans.set(note.lineId, { player: note.player ?? 1, start: note.start, end: note.start + note.duration });
    else {
      span.start = Math.min(span.start, note.start);
      span.end = Math.max(span.end, note.start + note.duration);
    }
  }
  const both = [...spans].filter(([, span]) => span.player === 3);
  for (const [, part] of both) {
    const clash = [...spans.values()].find(
      (span) => span.player !== 3 && span.start < part.end && part.start < span.end,
    );
    if (clash)
      throw new UltraStarError(`A part for both singers (P3) overlaps the lines of P${clash.player}.`, {
        code: "UNSUPPORTED_PLAYER",
      });
  }
  for (const player of [1, 2]) {
    const ids = new Map(both.map(([lineId]) => [lineId, createId("line")]));
    for (const note of notes.filter((item) => item.player === 3))
      notes.push({ ...note, id: createId("note"), player, lineId: ids.get(note.lineId)! });
    for (const lineBreak of lineBreaks.filter((item) => ids.has(item.lineId)))
      lineBreaks.push({ ...lineBreak, lineId: ids.get(lineBreak.lineId)! });
  }
  const shared = new Set(both.map(([lineId]) => lineId));
  notes.splice(0, notes.length, ...notes.filter((note) => note.player !== 3));
  // A break written in one singer's block can land past the P3 part now between its lines: such a line goes back
  // to the default break.
  const lines = new Map<string, { player: number; start: number; end: number }>();
  for (const note of notes) {
    const line = lines.get(note.lineId);
    if (!line) lines.set(note.lineId, { player: note.player ?? 1, start: note.start, end: note.start + note.duration });
    else {
      line.start = Math.min(line.start, note.start);
      line.end = Math.max(line.end, note.start + note.duration);
    }
  }
  const nextStart = new Map<string, number>();
  for (const player of [1, 2]) {
    const sung = [...lines].filter(([, line]) => line.player === player).toSorted(([, a], [, b]) => a.start - b.start);
    sung.forEach(([lineId], index) => {
      if (index + 1 < sung.length) nextStart.set(lineId, sung[index + 1]![1].start);
    });
  }
  const fits = (lineBreak: ChartLineBreak) => {
    const line = lines.get(lineBreak.lineId);
    const next = nextStart.get(lineBreak.lineId);
    return !line || next === undefined || (lineBreak.start >= line.end && (lineBreak.end ?? lineBreak.start) <= next);
  };
  lineBreaks.splice(
    0,
    lineBreaks.length,
    ...lineBreaks.filter((lineBreak) => !shared.has(lineBreak.lineId) && fits(lineBreak)),
  );
}

/** Absolute UltraStar TXT only. Rejects relative timing and unknown body records; P3 becomes copies in P1 and P2. */
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
      throw new UltraStarError("This isn't a text file.", {
        line: lineNumber,
      });
    const line = raw.trimStart();
    if (!line.trim()) continue;
    if (ended)
      throw new UltraStarError("There is more after the end marker (E). Only one chart per file is supported.", {
        line: lineNumber,
      });
    if (line.startsWith("#")) {
      if (inBody) throw new UltraStarError("Headers must precede notes and player records.", { line: lineNumber });
      const match = /^#([^:]+):(.*)$/s.exec(line);
      if (!match) throw new UltraStarError("A header isn't written as #NAME:value.", { line: lineNumber });
      const key = match[1]!.trim().toUpperCase();
      if (!/^[A-Z0-9_][A-Z0-9_-]*$/.test(key)) throw new UltraStarError("Invalid header name.", { line: lineNumber });
      if (Object.prototype.hasOwnProperty.call(metadata, key)) {
        if (metadata[key] !== match[2])
          throw new UltraStarError(`#${key} is there twice, with different values. Keep one.`, {
            line: lineNumber,
          });
        warnings.push(`Line ${lineNumber}: duplicate #${key} header retained once.`);
      }
      metadata[key] = match[2]!;
      if (key === "RELATIVE" && isRelativeModeUnsupported(metadata)) {
        throw new UltraStarError("Charts with relative timing (#RELATIVE) aren't supported.", {
          line: lineNumber,
          code: "UNSUPPORTED_RELATIVE",
        });
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
      const match = /^P[ \t]*([123])[ \t]*$/.exec(line);
      if (!match)
        throw new UltraStarError("Only P1, P2 and P3 (both singers) are supported.", {
          line: lineNumber,
          code: "UNSUPPORTED_PLAYER",
        });
      if (!explicitPlayers && notes.length) {
        warnings.push(`Line ${lineNumber}: notes preceding the first player marker were assigned to player 1.`);
        for (const note of notes) note.player = 1;
      }
      explicitPlayers = true;
      player = Number(match[1]);
      // No line goes on across a part for both (P3): starting one ends every singer's line, a singer's ends P3's.
      for (const [number, state] of tracks) {
        if (state.hasNotes && (player === 3 ? number !== 3 : number === 3)) {
          state.lineId = createId("line");
          state.hasNotes = false;
        }
      }
      track();
      continue;
    }
    if (line.startsWith("-")) {
      const match = /^-[ \t]+([+-]?\d+)(?:[ \t]+([+-]?\d+))?[ \t]*$/.exec(line);
      if (!match)
        throw new UltraStarError("A line break isn't written as - <beat> or - <beat> <beat>.", {
          line: lineNumber,
        });
      const start = integer(match[1]!, "Line break tick", lineNumber);
      const end = match[2] === undefined ? undefined : integer(match[2]!, "Line break end tick", lineNumber);
      if (end !== undefined && end < start)
        throw new UltraStarError("A line break ends before it starts.", { line: lineNumber });
      const state = track();
      if (!state.hasNotes) warnings.push(`Line ${lineNumber}: a line break after an empty line was left out.`);
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
        `Unsupported or malformed record ${JSON.stringify(line.slice(0, 70))}. Expected :, *, F, R, G, -, P1/P2/P3 or E.`,
        { line: lineNumber, code: "UNSUPPORTED_RECORD" },
      );
    const start = integer(match[2]!, "Note start", lineNumber);
    const length = integer(match[3]!, "Note length", lineNumber);
    const pitch = integer(match[4]!, "Note pitch", lineNumber) + 60;
    if (length <= 0) throw new UltraStarError("A note has no length.", { line: lineNumber });
    if (!Number.isSafeInteger(pitch) || !Number.isSafeInteger(start + length))
      throw new UltraStarError("Note pitch or end exceeds the safe integer range.", { line: lineNumber });
    const state = track();
    if (state.lastStart !== undefined && start < state.lastStart)
      warnings.push(`Line ${lineNumber}: notes of singer ${player} are out of order. They are put in order.`);
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
  if (tracks.has(3)) {
    singBoth(notes, lineBreaks);
    warnings.push("Notes for both singers (P3) were copied to P1 and P2.");
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
  if (!ended) warnings.push("The end marker (E) is missing.");
  if (metadata.GAP === undefined) warnings.push("There is no #GAP, so it is 0.");
  if (text.includes("�"))
    warnings.push("Some characters are damaged (�). The file may have been saved in another encoding.");
  if (explicitPlayers) {
    for (const number of tracks.keys()) {
      if (number !== 3 && !notes.some((note) => note.player === number))
        warnings.push(`Singer ${number} has no notes.`);
    }
  }
  warnings.push(...diagnostics.filter((item) => item.severity === "warning").map((item) => item.message));
  return { document, warnings };
}

/**
 * The beat a line break goes on when the chart doesn't say (`defaultSwitch`), between a line ending at beat `lastEnd`
 * and the next starting at `nextStart`: what export writes, and what import recognises as the default.
 */
export function defaultBreakTick(lastEnd: number, nextStart: number, grid: ChartGrid): number {
  const gapEnd = Math.max(lastEnd, nextStart);
  const time = defaultSwitch(ticksToSeconds(lastEnd, grid), ticksToSeconds(gapEnd, grid), tickDuration(grid.bpm));
  const tick = Math.round(secondsToTicks(time, grid));
  if (!Number.isSafeInteger(tick)) throw new UltraStarError("A line break is too far into the song.");
  return Math.min(Math.max(tick, lastEnd), gapEnd);
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
    if (!Number.isSafeInteger(tick)) throw new UltraStarError("A line break is too far into the song.");
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
      } else if (nextStart !== undefined) {
        // The default the editor draws, so the file reads the same in every game and editor.
        output.push(`- ${defaultBreakTick(lastEnd, nextStart, grid)}`);
      }
    }
  }
  output.push("E");
  return { text: `${output.join("\n")}\n`, warnings };
}

export function serializeUltraStar(document: ChartDocument): string {
  return serializeUltraStarWithDiagnostics(document).text;
}
