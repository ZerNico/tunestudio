import { Effect } from "effect";

import type { HeardLyrics, ImportProgress } from "../../src/lib/native/types";
import { abortable } from "../abortable";
import { ListeningFailed } from "../errors";
import { Models } from "../models/models";
import { Native } from "../native/native";
import { AppLog } from "../services/app-log";
import { decodeF32 } from "../tools/ffmpeg";
import { voicedRanges } from "./ranges";

export const LISTENING = "Listening to the song";
export const GETTING_LISTENING_MODEL = "Getting the listening model";

const failed = (message: string) => new ListeningFailed({ message: `Couldn't listen to the song: ${message}` });

/**
 * What Whisper writes when it hears nothing it understands: video captions and credits from its
 * training data, not lyrics.
 */
const MADE_UP = [
  /^(thank you|thanks) (so much )?for watching/i,
  /^(subtitles|captions|untertitel|sous-titres|subtítulos)\b/i,
  /^(amara\.org|www\.|https?:)/i,
  // Only punctuation or symbols: no letter or digit in any script.
  /^[^\p{L}\p{N}]*$/u,
];

/** About as long as a line of a song gets. */
const LINE_LENGTH = 40;

/**
 * Splits a sentence Whisper heard into lines of a song: at its commas, joining short parts up to
 * about 40 characters. Whisper writes a verse as one sentence; its lines' times are estimated
 * from where they start in it (the pitch step times them from the audio later).
 */
function splitLines(segment: { start: number; end: number; text: string }): HeardLyrics["lines"] {
  if (segment.text.length <= LINE_LENGTH) return [segment];
  const clauses = segment.text.match(/[^,;]+[,;]?/g)?.map((clause) => clause.trim()) ?? [segment.text];
  const parts: { offset: number; text: string }[] = [];
  let offset = 0;
  for (const clause of clauses) {
    const last = parts.at(-1);
    if (last && last.text.length + 1 + clause.length <= LINE_LENGTH) last.text = `${last.text} ${clause}`;
    else parts.push({ offset, text: clause });
    offset += clause.length + 1;
  }
  const length = segment.end - segment.start;
  return parts.map((part, index) => ({
    start: round(segment.start + (length * part.offset) / segment.text.length),
    end:
      index + 1 < parts.length
        ? round(segment.start + (length * parts[index + 1]!.offset) / segment.text.length)
        : segment.end,
    // A line of its own starts with a capital and doesn't trail a comma.
    text: part.text.replace(/[,;]$/, "").replace(/^\p{Ll}/u, (letter) => letter.toUpperCase()),
  }));
}

const round = (seconds: number) => Math.round(seconds * 100) / 100;

/**
 * Whether Whisper made a segment up from leftovers of the band: it is unsure of it, or unsure
 * and stretches a word or two over seconds (sung lines have a few characters a second).
 */
function madeUp(segment: { start: number; end: number; text: string; confidence: number }): boolean {
  const perSecond = segment.text.length / Math.max(0.01, segment.end - segment.start);
  return (
    segment.confidence < 0.3 ||
    (perSecond < 2 && segment.confidence < 0.7) ||
    MADE_UP.some((pattern) => pattern.test(segment.text))
  );
}

/** Whisper's segments as lyrics lines, without what it made up. */
export function lyricsLines(
  segments: readonly { start: number; end: number; text: string; confidence: number }[],
): HeardLyrics["lines"] {
  return segments
    .map((segment) => ({ ...segment, text: segment.text.replace(/\s+/g, " ").trim() }))
    .filter((segment) => !madeUp(segment))
    .flatMap(({ start, end, text }) => splitLines({ start, end, text }));
}

/**
 * Writes down what is sung in the separated `vocals` with Whisper: only where something is sung,
 * in `language` or the language most of the song is in, or with `mixed` each stretch in its own.
 * Downloads the model first if needed.
 */
export function listenToVocals(
  input: { ffmpeg: string; vocals: string; folder: string; language: string | null; mixed: boolean },
  onProgress: (progress: ImportProgress) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const log = yield* AppLog;
    const addon = yield* (yield* Native).addon;
    const sampleRate = addon.transcribeSampleRate();

    const model = yield* (yield* Models).ensure("whisper", (received, total) =>
      onProgress({ step: GETTING_LISTENING_MODEL, done: received, total }),
    );
    yield* onProgress({ step: LISTENING, done: 0, total: 100, unit: "percent" });

    return yield* Effect.gen(function* () {
      const samples = yield* decodeF32(
        input.ffmpeg,
        input.vocals,
        { sampleRate, channels: 1, folder: input.folder, what: "the vocals" },
        failed,
      );

      const ranges = voicedRanges(samples, sampleRate);
      if (ranges.length === 0) {
        return { language: input.language ?? "en", mixed: input.mixed, lines: [] } satisfies HeardLyrics;
      }
      const started = Date.now();
      const transcript = yield* abortable({
        try: (signal) =>
          addon.transcribe(
            model,
            samples,
            { language: input.language ?? undefined, ranges, mixed: input.mixed },
            (percent) => Effect.runFork(onProgress({ step: LISTENING, done: percent, total: 100, unit: "percent" })),
            signal,
          ),
        catch: (error) => failed(error instanceof Error ? error.message : String(error)),
      });
      yield* log.write(
        "INFO",
        "listening",
        `Heard ${transcript.segments.length} lines in ${ranges.length} stretches (${transcript.language}) in ${((Date.now() - started) / 1000).toFixed(1)} s`,
      );
      return {
        language: transcript.language,
        mixed: input.mixed,
        lines: lyricsLines(transcript.segments),
      } satisfies HeardLyrics;
    });
  });
}
