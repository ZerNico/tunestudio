/** A stretch of audio in seconds. */
export interface TimeRange {
  start: number;
  end: number;
}

/** Loudness is measured in 20 ms frames. */
const FRAME = 0.02;
/** Quieter than the song's loud parts by this much counts as silence (separated vocals are near silent between lines). */
const BELOW_LOUD = 30;
/** Never count anything quieter than this as singing. */
const FLOOR = -50;
/** Pauses shorter than this are breaths within a line. */
const BREATH = 0.5;
/** Shorter sounds are clicks and leftovers of the separation. */
const SHORTEST = 0.25;
/** Kept around each sung stretch, so first and last syllables aren't cut. */
const PADDING = 0.2;
/** Whisper hears 30 s at a time; a little less leaves room for the padding. */
const LONGEST = 28;
/** Lines closer than this are heard together: Whisper understands more with some context. */
const TOGETHER = 3;
/** Whisper makes words up from anything shorter: an "and" from a breath or a leftover of the band. */
const TOO_SHORT = 1;

/** Loudness per frame in dBFS. */
function frameLoudness(samples: Float32Array, sampleRate: number): number[] {
  const size = Math.max(1, Math.round(FRAME * sampleRate));
  const frames: number[] = [];
  for (let start = 0; start + size <= samples.length; start += size) {
    let sum = 0;
    for (let i = start; i < start + size; i++) sum += samples[i]! * samples[i]!;
    frames.push(10 * Math.log10(sum / size + 1e-12));
  }
  return frames;
}

/**
 * Where something is sung in separated vocals, grouped into stretches of at most 28 s for
 * Whisper: nearby lines together, long passages split at their quietest moment. Transcribing
 * only these keeps Whisper from making up words in the instrumental parts.
 */
export function voicedRanges(samples: Float32Array, sampleRate: number): TimeRange[] {
  const loudness = frameLoudness(samples, sampleRate);
  if (loudness.length === 0) return [];
  const sorted = loudness.toSorted((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.95)]!;
  const threshold = Math.max(FLOOR, loud - BELOW_LOUD);
  const duration = samples.length / sampleRate;

  // Sung stretches: loud frames, joined across breaths, without clicks.
  const runs: TimeRange[] = [];
  loudness.forEach((level, index) => {
    if (level < threshold) return;
    const start = index * FRAME;
    const last = runs.at(-1);
    if (last && start - last.end < BREATH) last.end = start + FRAME;
    else runs.push({ start, end: start + FRAME });
  });
  const sung = runs
    .filter((run) => run.end - run.start >= SHORTEST)
    .map((run) => ({ start: Math.max(0, run.start - PADDING), end: Math.min(duration, run.end + PADDING) }));

  // Split passages that are too long at their quietest frame in the last few seconds.
  const pieces: TimeRange[] = [];
  for (const run of sung) {
    let start = run.start;
    while (run.end - start > LONGEST) {
      const from = Math.floor((start + LONGEST - 8) / FRAME);
      const to = Math.floor((start + LONGEST) / FRAME);
      let quietest = to;
      for (let index = from; index < to; index++) {
        if (loudness[index]! < loudness[quietest]!) quietest = index;
      }
      pieces.push({ start, end: quietest * FRAME });
      start = quietest * FRAME;
    }
    pieces.push({ start, end: run.end });
  }

  // Nearby pieces heard together, up to Whisper's window.
  const ranges: TimeRange[] = [];
  for (const piece of pieces) {
    const last = ranges.at(-1);
    if (last && piece.start - last.end < TOGETHER && piece.end - last.start <= LONGEST) last.end = piece.end;
    // The padding can reach into the previous range; no word should be heard twice.
    else ranges.push({ start: Math.max(piece.start, last?.end ?? 0), end: piece.end });
  }
  return ranges
    .filter((range) => range.end - range.start >= TOO_SHORT)
    .map((range) => ({ start: round(range.start), end: round(range.end) }));
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
