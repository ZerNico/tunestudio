import { isAbort } from "~/lib/native/errors";
import type { ImportProgress } from "~/lib/native/types";

/** A thin progress bar in the dialog. */
export const progressBarClass =
  "h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-sage-22 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-150";

/** How far a step is, in percent, or undefined when it can't say. */
export const percentOf = (progress: ImportProgress | null) =>
  progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : undefined;

/**
 * Runs one of main's long calls to its end, passing its progress on. Resolves with the result, or null as soon as
 * `signal` aborts; other failures are thrown. A result that still arrives after that goes to `onLate`, so what it
 * made can be cleaned up.
 */
export async function follow<R>(
  start: () => Promise<AsyncIterator<ImportProgress, R>>,
  signal: AbortSignal,
  onProgress: (progress: ImportProgress) => void,
  onLate?: (result: R) => void,
): Promise<R | null> {
  const stopped = new Promise<null>((resolve) => {
    if (signal.aborted) resolve(null);
    else signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  try {
    const iterator = await Promise.race([start(), stopped]);
    if (!iterator) return null;
    for (;;) {
      const pending = iterator.next();
      const next = await Promise.race([pending, stopped]);
      if (!next) {
        pending.then((late) => late.done && onLate?.(late.value)).catch(() => {});
        return null;
      }
      if (next.done) return next.value;
      if (signal.aborted) return null;
      onProgress(next.value);
    }
  } catch (error) {
    if (isAbort(error) || signal.aborted) return null;
    throw error;
  }
}
