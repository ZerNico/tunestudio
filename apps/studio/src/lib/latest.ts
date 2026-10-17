/**
 * Work where only the latest run counts (a new file's pitch, its waveform): starting it again aborts the run before,
 * whose late result its signal says to drop.
 */
export function createLatest() {
  let controller = new AbortController();
  return {
    /** The signal of a new run (the one before is aborted). */
    next(): AbortSignal {
      controller.abort();
      controller = new AbortController();
      return controller.signal;
    },
    /** Aborts the run under way. */
    abort: () => controller.abort(),
  };
}
