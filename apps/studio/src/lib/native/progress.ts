/**
 * Main's long calls (downloads, separation, charting) as the renderer follows them: their progress in percent, and
 * running one to its end or until it is stopped.
 */
import { isAbort } from "./errors";
import type { Progress } from "./types";

/** How far a step is, in percent, or undefined when it can't say. */
export const percentOf = (progress: Progress | null) =>
  progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : undefined;

/**
 * Runs one of main's long calls to its end, passing its progress on. Resolves with the result, or null as soon as
 * `signal` aborts; other failures are thrown. A result that still arrives after that goes to `onLate`, so what it
 * made can be cleaned up.
 */
export async function follow<R>(
  start: () => Promise<AsyncIterator<Progress, R>>,
  signal: AbortSignal,
  onProgress: (progress: Progress) => void,
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
