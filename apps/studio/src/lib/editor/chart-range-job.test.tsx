import { createRoot, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import { ChartFailed } from "~/lib/errors";
import type { ChartRangeInput } from "~/lib/native/contract";
import type { EditorChart, RangeChart } from "~/lib/native/types";

import { createChartRangeJob } from "./chart-range-job";
import { createChartDocument } from "./document";
import { NOTHING, type Selection } from "./selection";
import { testSong } from "./test-chart";

const asked: ChartRangeInput = { id: "project", singerId: 7, start: 1, end: 2, lines: ["da"], language: "en" };
const output: RangeChart = {
  bpm: 300,
  gap: 0,
  vocals: "sha",
  breaks: [],
  lines: [{ notes: [{ start: 1.1, duration: 0.3, pitch: 65, lyric: "da", type: "normal" }] }],
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function setup(save: () => Promise<void> = async () => {}) {
  return createRoot(() => {
    const chart: EditorChart = {
      bpm: 300,
      gap: 0,
      song: testSong,
      singers: [{ id: 7, index: 1, name: null, lines: [] }],
    };
    let media = [{ id: 1, url: "same" }];
    let project = "project";
    let selected: Selection = NOTHING;
    const doc = createChartDocument({
      chart,
      save,
      onFailed: () => {},
      selection: () => selected,
      setSelection: (s: Selection) => {
        selected = s;
      },
    });
    const pending: ReturnType<typeof deferred<RangeChart | null>>[] = [];
    const signals: AbortSignal[] = [];
    const done = vi.fn();
    const request = vi.fn(async (_input, signal: AbortSignal) => {
      signals.push(signal);
      const next = deferred<RangeChart | null>();
      pending.push(next);
      return next.promise;
    });
    const job = createChartRangeJob({
      doc: () => doc,
      project: () => project,
      media: () => media,
      request,
      onDone: done,
    });
    return {
      doc,
      job,
      request,
      pending,
      signals,
      done,
      changeMedia: () => {
        media = [{ id: 1, url: "same" }];
      },
      changeProject: () => {
        project = "other";
      },
    };
  });
}

describe("range chart job", () => {
  it("applies once, selects new notes and prevents simultaneous starts", async () => {
    const { job, pending, request, doc, done } = setup();
    const run = job.run(asked);
    void job.run(asked);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    pending[0]!.resolve(output);
    await run;
    flush();
    expect(doc.chart().singers[0]!.lines).toHaveLength(1);
    expect(doc.undoLabel()).toBe("Chart from lyrics");
    expect(done).toHaveBeenCalledOnce();
  });

  it.each(["edit", "undo", "media", "project"])(
    "rejects results after %s even when the chart or media looks the same",
    async (change) => {
      const { job, pending, doc, changeMedia, changeProject, done } = setup();
      const run = job.run(asked);
      await Promise.resolve();
      if (change === "media") changeMedia();
      else if (change === "project") changeProject();
      else {
        doc.edit("Title", (tx) => tx.updateSong({ title: "Changed" }));
        if (change === "undo") doc.undo();
      }
      pending[0]!.resolve(output);
      await run;
      flush();
      expect(done).not.toHaveBeenCalled();
      expect(doc.chart().singers[0]!.lines).toHaveLength(0);
      expect(job.error()).toContain("song changed");
    },
  );

  it("Stop and immediate retry ignore an old result without clearing the new progress", async () => {
    const { job, pending, signals, doc, done } = setup();
    const old = job.run(asked);
    await Promise.resolve();
    job.stop();
    const next = job.run(asked);
    await Promise.resolve();
    expect(signals[0]!.aborted).toBe(true);
    pending[0]!.resolve(output);
    await old;
    flush();
    expect(job.busy()).toBe(true);
    expect(done).not.toHaveBeenCalled();
    pending[1]!.resolve(output);
    await next;
    flush();
    expect(doc.chart().singers[0]!.lines).toHaveLength(1);
    expect(done).toHaveBeenCalledOnce();
  });

  it("does not request after Stop while waiting for saves", async () => {
    const gate = deferred<void>();
    const { job, doc, request } = setup(() => gate.promise);
    doc.edit("Title", (tx) => tx.updateSong({ title: "Changed" }));
    const run = job.run(asked);
    job.stop();
    gate.resolve();
    await run;
    expect(request).not.toHaveBeenCalled();
  });

  it("does not request after a failed save, even without a new document", async () => {
    const { job, doc, request } = setup(async () => {
      throw new Error("disk full");
    });
    doc.edit("Title", (tx) => tx.updateSong({ title: "Changed" }));
    await job.run(asked);
    flush();
    expect(request).not.toHaveBeenCalled();
    expect(job.error()).toContain("song changed");
  });

  it("keeps the chart unchanged after failure or an empty result and allows retry", async () => {
    const { job, pending, doc } = setup();
    const first = job.run(asked);
    await Promise.resolve();
    pending[0]!.reject(new ChartFailed({ message: "No notes found" }));
    await first;
    flush();
    expect(job.error()).toBe("No notes found");
    const second = job.run(asked);
    await Promise.resolve();
    pending[1]!.resolve({ ...output, lines: [] });
    await second;
    flush();
    expect(doc.undoLabel()).toBeNull();
    expect(doc.chart().singers[0]!.lines).toHaveLength(0);
  });
});
