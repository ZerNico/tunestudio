import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import { createAutoPitchJob } from "./auto-pitch-job";
import type { DrawnNote } from "./chart";
import { testNote } from "./test-chart";

const notes: DrawnNote[] = [
  { ...testNote(1, 1, "We "), singer: 1, lineId: 10 },
  { ...testNote(2, 2, "walk"), singer: 1, lineId: 10 },
];

function setup(request: (ids: number[], signal: AbortSignal) => Promise<{ id: number; pitch: number }[] | null>) {
  return createRoot(() => {
    const first = { saved: vi.fn(async () => {}) };
    const [doc, setDoc] = createSignal(first);
    const apply = vi.fn();
    const onMessage = vi.fn();
    const job = createAutoPitchJob({ notes: () => notes, doc, request, apply, onMessage });
    return { job, apply, onMessage, setDoc, first };
  });
}

describe("auto pitch job", () => {
  it("saves first, applies the pitches with the notes as they were asked about, and is busy meanwhile", async () => {
    let answer!: (pitches: { id: number; pitch: number }[]) => void;
    const request = vi.fn(() => new Promise<{ id: number; pitch: number }[]>((resolve) => (answer = resolve)));
    const { job, apply, first } = setup(request);
    job.run([2]);
    flush();
    expect([job.busy(), [...job.pending()]]).toEqual([true, [2]]);
    // A second run while one is under way is ignored.
    job.run([1]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(first.saved).toHaveBeenCalled();
    answer([{ id: 2, pitch: 67 }]);
    await vi.waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply).toHaveBeenCalledWith([{ id: 2, pitch: 67 }], new Map([[2, { start: 2, duration: 0.3, pitch: 64 }]]));
    flush();
    expect([job.busy(), job.pending().size]).toEqual([false, 0]);
  });

  it("says when nothing is sung there, and when it failed", async () => {
    const empty = setup(async () => []);
    empty.job.run([1]);
    await vi.waitFor(() =>
      expect(empty.onMessage).toHaveBeenCalledWith({ title: "Nothing is sung there to take the pitch from." }),
    );
    const failing = setup(async () => Promise.reject(new Error("The song needs its vocals separated first.")));
    failing.job.run([1]);
    await vi.waitFor(() =>
      expect(failing.onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Couldn't find the pitch", error: true }),
      ),
    );
  });

  it("drops a result for a chart made anew meanwhile, and stops when asked", async () => {
    let answer!: (pitches: { id: number; pitch: number }[]) => void;
    let seen!: AbortSignal;
    const { job, apply, setDoc } = setup(
      (_ids, signal) => (
        (seen = signal),
        new Promise<{ id: number; pitch: number }[]>((resolve) => (answer = resolve))
      ),
    );
    job.run([1]);
    await vi.waitFor(() => expect(seen).toBeDefined());
    setDoc({ saved: vi.fn(async () => {}) });
    flush();
    answer([{ id: 1, pitch: 60 }]);
    await vi.waitFor(() => expect(job.busy()).toBe(false));
    expect(apply).not.toHaveBeenCalled();
    job.run([1]);
    await vi.waitFor(() => expect(seen.aborted).toBe(false));
    job.stop();
    expect(seen.aborted).toBe(true);
  });
});
