export interface TimeRange {
  start: number;
  end: number;
}

/** Shared by the review, replacement and main-process edge check so adjacent grid notes stay outside. */
export function intersectsRange(note: { start: number; duration: number }, range: TimeRange): boolean {
  return note.start < range.end - 1e-6 && note.start + note.duration > range.start + 1e-6;
}

/** Empty rows are spacing, not lyric lines. */
export function lyricLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** A reason the passage cannot be charted, or null when it can. */
export function rangeProblem(range: TimeRange, lines: readonly string[]): string | null {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start)
    return "Select a time range first.";
  if (!lines.length) return "Enter the lyrics sung in this range.";
  if (lines.some((line) => !/\p{L}/u.test(line))) return "Each line needs words to sing.";
  return null;
}
