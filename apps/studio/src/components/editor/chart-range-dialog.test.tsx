import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createRoot, untrack } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import { createChartRangeJob } from "~/lib/editor/chart-range-job";
import { createChartDocument } from "~/lib/editor/document";
import { NOTHING, type Selection } from "~/lib/editor/selection";
import { testNote, testSong } from "~/lib/editor/test-chart";
import { ChartFailed } from "~/lib/errors";
import type { ChartRangeInput } from "~/lib/native/contract";
import type { EditorChart, ImportProgress, RangeChart } from "~/lib/native/types";

import { ChartRangeDialog } from "./chart-range-dialog";

function setup() {
  return createRoot(() => {
    const chart: EditorChart = {
      bpm: 300,
      gap: 0,
      song: { ...testSong, language: ["German"] },
      singers: [
        {
          id: 17,
          index: 1,
          name: "First",
          lines: [
            {
              id: 10,
              switchStart: null,
              switchEnd: null,
              notes: [testNote(100, 1, "Hello ", 0.5), testNote(101, 2, "there", 0.5)],
            },
          ],
        },
        {
          id: 29,
          index: 2,
          name: "Second",
          lines: [{ id: 11, switchStart: null, switchEnd: null, notes: [testNote(102, 1.5, "Hallo", 0.5)] }],
        },
      ],
    };
    let resolve!: (value: RangeChart | null) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<RangeChart | null>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const pending = { promise, resolve, reject };
    const request = vi.fn(
      async (_input: ChartRangeInput, _signal: AbortSignal, progress: (value: ImportProgress) => void) => {
        progress({ step: "Aligning lyrics", done: 40, total: 100 });
        return pending.promise;
      },
    );
    const doc = createChartDocument<Selection>({
      chart,
      save: async () => {},
      onFailed: () => {},
      selection: () => NOTHING,
      setSelection: () => {},
    });
    const job = createChartRangeJob({
      doc: () => doc,
      project: () => "project",
      media: () => null,
      request,
      onDone: () => {},
    });
    const close = vi.fn();
    const rendered = render(() => (
      <ChartRangeDialog
        chart={chart}
        project="project"
        range={{ start: 1.2, end: 2.2 }}
        singerId={17}
        duration={10}
        job={job}
        onClose={close}
      />
    ));
    return { job, request, pending, close, rendered, doc };
  });
}

describe("chart range dialog", () => {
  it("shows whole-note bounds, prefills lyrics and uses database singer IDs", async () => {
    const { request, job, pending } = setup();
    const user = userEvent.setup();
    expect(await screen.findByRole("textbox", { name: "Lyrics" })).toHaveValue("Hello there");
    expect(screen.getByTestId("chart-range-scope")).toHaveTextContent("0:01.0 to 0:02.5 · 2 notes replaced");
    expect(screen.getByRole("combobox", { name: "Lyrics language" })).toHaveTextContent("German");
    await user.click(screen.getByRole("button", { name: "Chart range" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request.mock.calls[0]![0]).toEqual({
      id: "project",
      singerId: 17,
      start: 1,
      end: 2.5,
      lines: ["Hello there"],
      language: "de",
    });
    expect(await screen.findByRole("progressbar")).toHaveAttribute("value", "40");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(untrack(job.busy)).toBe(false);
    expect(request.mock.calls[0]![1].aborted).toBe(true);
    pending.resolve(null);
  });

  it("changes scope and untouched prefill with singers, but preserves typed lyrics", async () => {
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("combobox", { name: "Singer" }));
    await user.click(await screen.findByRole("option", { name: "Second" }));
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue("Hallo");
    expect(screen.getByTestId("chart-range-scope")).toHaveTextContent("1 note replaced");
    const input = screen.getByRole("textbox", { name: "Lyrics" });
    await user.clear(input);
    await user.type(input, "New words{Enter}(oh)");
    await user.click(screen.getByRole("combobox", { name: "Singer" }));
    await user.click(await screen.findByRole("option", { name: "First" }));
    expect(input).toHaveValue("New words\n(oh)");
    await user.clear(input);
    expect(screen.getByRole("button", { name: "Chart range" })).toBeDisabled();
  });

  it("keeps lyrics after a failed request and stops when closed or unmounted", async () => {
    const { pending, close, request, rendered } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Chart range" }));
    pending.reject(new ChartFailed({ message: "No notes found" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No notes found");
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue("Hello there");
    // Fixing the lyrics clears the old failure.
    await user.type(screen.getByRole("textbox", { name: "Lyrics" }), "!");
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledOnce();
    rendered.unmount();
    expect(request).toHaveBeenCalledOnce();
  });
});
