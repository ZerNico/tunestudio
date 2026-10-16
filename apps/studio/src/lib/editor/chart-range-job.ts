import { createSignal } from "solid-js";

import { rangeProblem } from "~/lib/chart-range";
import { ChartFailed } from "~/lib/errors";
import type { ChartRangeInput } from "~/lib/native/contract";
import { errorMessage, isAbort } from "~/lib/native/errors";
import type { ImportProgress, RangeChart } from "~/lib/native/types";

import { replaceRange, validRangeChart } from "./chart-range";
import type { ChartDocument } from "./document";
import { notesOnly, type Selection } from "./selection";

/** One cancellable request, applied only to the exact document and media that were reviewed. */
export function createChartRangeJob(options: {
  doc: () => ChartDocument<Selection>;
  project: () => string;
  media: () => unknown;
  request: (
    input: ChartRangeInput,
    signal: AbortSignal,
    onProgress: (progress: ImportProgress) => void,
  ) => Promise<RangeChart | null>;
  onDone: () => void;
}) {
  const [progress, setProgress] = createSignal<ImportProgress | null | undefined>();
  const [error, setError] = createSignal<string | null>(null);
  let controller: AbortController | undefined;
  const stop = () => {
    controller?.abort();
    controller = undefined;
    setProgress(undefined);
  };
  const run = async (input: ChartRangeInput) => {
    if (controller) return;
    const problem = rangeProblem(input, input.lines);
    if (problem) {
      setError(problem);
      return;
    }
    const mine = new AbortController();
    controller = mine;
    const doc = options.doc();
    const revision = doc.revision();
    const snapshot = JSON.stringify(doc.chart());
    const media = options.media();
    const source = JSON.stringify(media);
    const current = () => controller === mine && !mine.signal.aborted;
    const unchanged = () =>
      options.doc() === doc &&
      options.project() === input.id &&
      doc.revision() === revision &&
      JSON.stringify(doc.chart()) === snapshot &&
      options.media() === media &&
      JSON.stringify(options.media()) === source;
    setError(null);
    setProgress(null);
    try {
      await doc.saved();
      if (!current()) return;
      if (!unchanged()) throw new ChartFailed({ message: "The song changed. Chart the range again." });
      const result = await options.request(input, mine.signal, (next) => {
        if (current()) setProgress(next);
      });
      if (!current() || !result) return;
      if (!unchanged()) throw new ChartFailed({ message: "The song changed. Chart the range again." });
      if (result.lines.length !== input.lines.length || !validRangeChart(doc.chart(), input, result))
        throw new ChartFailed({ message: "The lyrics don't fit in this range. Choose more time or fewer words." });
      let ids: number[] = [];
      const applied = doc.edit(
        "Chart from lyrics",
        (tx) => {
          ids = replaceRange(tx, doc.chart(), input.singerId, input, result);
        },
        { selectionAfter: () => notesOnly(ids) },
      );
      if (!applied) throw new ChartFailed({ message: "The range couldn't be replaced. Select it again." });
      options.onDone();
    } catch (cause) {
      if (current() && !isAbort(cause)) setError(errorMessage(cause));
    } finally {
      if (controller === mine) {
        controller = undefined;
        setProgress(undefined);
      }
    }
  };
  return { progress, error, clearError: () => setError(null), busy: () => progress() !== undefined, run, stop };
}

export type ChartRangeJob = ReturnType<typeof createChartRangeJob>;
