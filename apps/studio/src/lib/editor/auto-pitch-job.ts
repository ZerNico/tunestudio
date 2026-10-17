/**
 * Auto pitch from the editor's side (A, the wand, the note menu): one run at a time. It saves the edits so far (main
 * reads the chart as it is drawn), asks main for the notes' pitch (`request`; slow, with progress, stoppable), and
 * hands the result to `apply` with the notes as they were asked about, so notes changed meanwhile are left alone. A
 * result for a chart made anew, or for vocals replaced meanwhile (separated again), is dropped.
 */
import { createSignal } from "solid-js";

import { errorMessage, isAbort } from "~/lib/native/errors";
import type { Progress } from "~/lib/native/types";

import type { DrawnNote } from "./chart";

/** A note as it was when its pitch was asked for. */
export type AskedNote = { start: number; duration: number; pitch: number };

export function createAutoPitchJob(options: {
  notes: () => readonly DrawnNote[];
  /** The chart being edited (a new one when the chart is loaded again), with its saving. */
  doc: () => { saved: () => Promise<void> };
  /** The project's media (a new value when a file is replaced). */
  media: () => unknown;
  /** Asks main; null when stopped. */
  request: (
    ids: number[],
    signal: AbortSignal,
    onProgress: (progress: Progress) => void,
  ) => Promise<readonly { id: number; pitch: number }[] | null>;
  apply: (pitches: readonly { id: number; pitch: number }[], asked: ReadonlyMap<number, AskedNote>) => void;
  /** Tells the user something (nothing sung there; it failed). */
  onMessage: (message: { title: string; description?: string; error?: boolean }) => void;
}) {
  /** At work (undefined: not), with its progress once there is some. */
  const [progress, setProgress] = createSignal<Progress | null | undefined>(undefined);
  /** The notes being worked on (they pulse). */
  const [pending, setPending] = createSignal<ReadonlySet<number>>(new Set());
  let controller: AbortController | undefined;

  const run = async (ids: number[]) => {
    if (progress() !== undefined) return;
    const chosen = new Set(ids);
    const asked = new Map(
      options
        .notes()
        .filter((note) => chosen.has(note.id))
        .map((note) => [note.id, { start: note.start, duration: note.duration, pitch: note.pitch }]),
    );
    const asking = options.doc();
    const media = options.media();
    const mine = new AbortController();
    controller = mine;
    setProgress(null);
    setPending(chosen);
    try {
      await asking.saved();
      const pitches = await options.request(ids, mine.signal, setProgress);
      if (!pitches || mine.signal.aborted || options.doc() !== asking || options.media() !== media) return;
      if (pitches.length === 0) options.onMessage({ title: "Nothing is sung there to take the pitch from." });
      else options.apply(pitches, asked);
    } catch (error) {
      if (!isAbort(error))
        options.onMessage({
          title: "Couldn't find the pitch",
          description: errorMessage(error),
          error: true,
        });
    } finally {
      if (controller === mine) {
        setProgress(undefined);
        setPending(new Set<number>());
      }
    }
  };

  return {
    progress,
    pending,
    /** Whether a run is under way. */
    busy: () => progress() !== undefined,
    run: (ids: number[]) => void run(ids),
    stop: () => controller?.abort(),
  };
}
