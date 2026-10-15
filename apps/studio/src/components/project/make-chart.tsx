import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
import SparklesIcon from "~icons/lucide/sparkles";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { toast } from "~/components/ui/toast";
import { formatFileSize } from "~/lib/format";
import { native } from "~/lib/native/client";
import { errorMessage, isAbort } from "~/lib/native/errors";
import type { ImportProgress, ProjectOverview } from "~/lib/native/types";

/** Why a chart can't be made yet, or null when it can. */
export function chartBlocker(overview: ProjectOverview): string | null {
  if (!overview.lyrics?.lines.some((line) => line.text.trim())) return "Add the lyrics first.";
  if (!overview.media.some((item) => item.role === "vocals")) return "Separate the vocals first.";
  return null;
}

/** The progress label: the step, with bytes for downloads and a percentage otherwise. */
export function describeChartProgress(progress: ImportProgress | null): string {
  if (!progress) return "Starting…";
  if (progress.unit === "percent")
    return progress.done > 0 ? `${progress.step}… ${Math.round(progress.done)}%` : `${progress.step}…`;
  return `${progress.step}… ${formatFileSize(progress.done)} of ${formatFileSize(progress.total)}`;
}

/**
 * Makes the chart from the project's vocals and lyrics (`project.makeChart`), replacing its notes after asking when
 * there are any. Shows the progress, can be cancelled, and calls `onDone` with the updated overview.
 */
export function MakeChart(props: { overview: ProjectOverview; onDone: (overview: ProjectOverview) => void }) {
  const [progress, setProgress] = createSignal<ImportProgress | null>(null);
  const [running, setRunning] = createSignal(false);
  const [asking, setAsking] = createSignal(false);
  let controller: AbortController | undefined;
  const blocker = createMemo(() => chartBlocker(props.overview));

  const run = async () => {
    setAsking(false);
    controller = new AbortController();
    setRunning(true);
    setProgress(null);
    try {
      const iterator = await native.project.makeChart({ id: props.overview.id }, { signal: controller.signal });
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          props.onDone(next.value);
          toast.add({
            type: "success",
            title: "Made the chart",
            description: `${next.value.notes} notes in ${next.value.lines} lines. Check them against the song.`,
          });
          return;
        }
        setProgress(next.value);
      }
    } catch (error) {
      if (!(isAbort(error) || controller.signal.aborted)) {
        toast.add({ type: "error", title: "Couldn't make the chart", description: errorMessage(error) });
      }
    } finally {
      controller = undefined;
      setRunning(false);
    }
  };

  const start = () => {
    if (props.overview.notes > 0) setAsking(true);
    else void run();
  };

  return (
    <div class="flex flex-col gap-2" data-testid="make-chart">
      <Show
        when={running()}
        fallback={
          <div class="flex items-center gap-3">
            <Button size="sm" onClick={start} disabled={blocker() !== null} data-testid="make-chart-start">
              <SparklesIcon />
              Make the chart
            </Button>
            <span class="text-[11.5px] text-muted-foreground">
              {blocker() ?? "From the vocals and lyrics. Takes a minute or two."}
            </span>
          </div>
        }
      >
        <div class="flex items-center gap-3">
          <span class="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground" data-testid="make-chart-progress">
            {describeChartProgress(progress())}
          </span>
          <Button size="sm" variant="outline" onClick={() => controller?.abort()} data-testid="make-chart-cancel">
            Cancel
          </Button>
        </div>
        <progress
          aria-label="Chart progress"
          max="100"
          value={progress() && progress()!.total > 0 ? Math.min(100, (progress()!.done / progress()!.total) * 100) : 0}
          class="h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-sage-22 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-150"
        />
      </Show>

      <Dialog open={asking()} onOpenChange={(open: boolean) => setAsking(open)}>
        <DialogContent class="w-[min(480px,calc(100vw-32px))]" data-testid="replace-chart">
          <DialogHeader>
            <DialogTitle>Replace the chart?</DialogTitle>
            <DialogDescription>The song already has {props.overview.notes} notes.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p class="m-0 text-[11.5px] leading-[1.6] text-popover-foreground">
              Making the chart replaces all of its notes and lines with new ones from the vocals and lyrics.
            </p>
          </DialogBody>
          <DialogFooter>
            <DialogClose
              render={(closeProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
                <Button variant="outline" {...closeProps} />
              )}
            >
              Cancel
            </DialogClose>
            <Button variant="destructive" onClick={() => void run()} data-testid="confirm-replace-chart">
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
