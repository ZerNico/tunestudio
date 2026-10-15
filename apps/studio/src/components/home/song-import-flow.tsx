import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import CheckIcon from "~icons/lucide/check";
import CircleDashedIcon from "~icons/lucide/circle-dashed";
import FileMusicIcon from "~icons/lucide/file-music";
import LoaderCircleIcon from "~icons/lucide/loader-circle";
import OctagonAlertIcon from "~icons/lucide/octagon-alert";
import TriangleAlertIcon from "~icons/lucide/triangle-alert";

import { Button } from "~/components/ui/button";
import { DialogBody, DialogClose, DialogFooter } from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch as Toggle } from "~/components/ui/switch";
import { formatFileSize } from "~/lib/format";
import { native } from "~/lib/native/client";
import { errorMessage, isAbort } from "~/lib/native/errors";
import type { ImportProgress, MediaRole, OpenedProject, SongInspection } from "~/lib/native/types";

/** Labels for media roles, in the order the dialog lists them. */
export const ROLE_LABELS: Record<MediaRole, string> = {
  audio: "Audio",
  vocals: "Vocals",
  instrumental: "Instrumental",
  video: "Video",
  cover: "Cover",
  background: "Background",
};

type State =
  | { step: "checking" }
  | { step: "ready"; inspection: SongInspection }
  | { step: "saving"; inspection: SongInspection }
  | { step: "importing"; inspection: SongInspection; progress: ImportProgress | null }
  | { step: "failed"; message: string; inspection?: SongInspection };

/** The step the dialog's step list highlights: check, choose a location, copy. */
export function songFlowStep(state: State["step"]): number {
  return state === "saving" ? 1 : state === "importing" ? 2 : 0;
}

/**
 * Importing an UltraStar song: shows what the folder holds, asks where to save the project,
 * then copies everything in with progress. Closing the dialog while copying cancels the
 * import (main removes the half-written file).
 */
export function SongImportFlow(props: {
  path: string;
  /** False once the dialog closes. */
  open: boolean;
  header: (step: number) => JSX.Element;
  onOpened: (project: OpenedProject) => void;
  /** True while saving or copying, when closing would lose the user's progress. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [state, setState] = createSignal<State>({ step: "checking" });
  const [includeVideo, setIncludeVideo] = createSignal(true);
  let controller: AbortController | undefined;

  const inspect = async (chart?: string) => {
    setState({ step: "checking" });
    try {
      const inspection = await native.song.inspect({ path: props.path, ...(chart ? { chart } : {}) });
      setIncludeVideo(inspection.media.some((file) => file.role === "video" && file.found));
      setState({ step: "ready", inspection });
    } catch (error) {
      setState({ step: "failed", message: errorMessage(error) });
    }
  };

  onSettled(() => {
    void inspect();
  });

  createEffect(
    () => state().step === "saving" || state().step === "importing",
    (busy) => props.onBusyChange?.(busy),
  );

  createEffect(
    () => props.open,
    (open) => {
      if (!open) controller?.abort();
    },
  );

  const create = async (inspection: SongInspection) => {
    setState({ step: "saving", inspection });
    let target: string | null;
    try {
      target = await native.dialogs.chooseProjectLocation({ name: inspection.suggestedName });
    } catch (error) {
      setState({ step: "failed", message: errorMessage(error), inspection });
      return;
    }
    if (!target) {
      setState({ step: "ready", inspection });
      return;
    }
    controller = new AbortController();
    setState({ step: "importing", inspection, progress: null });
    try {
      const iterator = await native.song.import(
        { path: props.path, chart: inspection.chart, includeVideo: includeVideo(), target },
        { signal: controller.signal },
      );
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          props.onOpened(next.value);
          return;
        }
        setState({ step: "importing", inspection, progress: next.value });
      }
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) setState({ step: "ready", inspection });
      else setState({ step: "failed", message: errorMessage(error), inspection });
    } finally {
      controller = undefined;
    }
  };

  const current = () => {
    const value = state();
    return "inspection" in value ? value.inspection : undefined;
  };

  return (
    <>
      {props.header(songFlowStep(state().step))}
      <DialogBody aria-busy={state().step === "checking" || state().step === "importing" ? "true" : "false"}>
        <Switch>
          <Match when={state().step === "checking"}>
            <p class="m-0 flex items-center gap-2 text-[11.5px] text-popover-foreground" aria-live="polite">
              <LoaderCircleIcon class="size-4 animate-spin text-primary" />
              Reading the song…
            </p>
          </Match>
          <Match when={current()}>
            {(inspection) => (
              <SongSummary
                inspection={inspection()}
                includeVideo={includeVideo()}
                locked={state().step !== "ready" && state().step !== "failed"}
                onIncludeVideo={setIncludeVideo}
                onChart={(chart) => void inspect(chart)}
              />
            )}
          </Match>
        </Switch>
        <Show when={state().step === "importing" ? (state() as Extract<State, { step: "importing" }>) : undefined}>
          {(importing) => <ImportProgressBar progress={importing().progress} />}
        </Show>
        <Show when={state().step === "failed" ? (state() as Extract<State, { step: "failed" }>).message : undefined}>
          {(message) => (
            <Note tone="error" testid="song-import-error">
              {message()}
            </Note>
          )}
        </Show>
      </DialogBody>
      <DialogFooter class="items-center">
        <DialogClose
          render={(closeProps: JSX.HTMLAttributes<HTMLButtonElement>) => <Button variant="outline" {...closeProps} />}
        >
          Cancel
        </DialogClose>
        <Show
          when={state().step === "failed" && !current()}
          fallback={
            <Button
              disabled={state().step !== "ready" || Boolean(current()?.blocker)}
              onClick={() => {
                const inspection = current();
                if (inspection) void create(inspection);
              }}
              data-testid="song-create"
            >
              <Show when={state().step === "importing" || state().step === "saving"}>
                <LoaderCircleIcon class="animate-spin" />
              </Show>
              Create project…
            </Button>
          }
        >
          <Button onClick={() => void inspect()}>Try again</Button>
        </Show>
      </DialogFooter>
    </>
  );
}

function SongSummary(props: {
  inspection: SongInspection;
  includeVideo: boolean;
  locked: boolean;
  onIncludeVideo: (value: boolean) => void;
  onChart: (chart: string) => void;
}) {
  const video = () => props.inspection.media.find((file) => file.role === "video" && file.found);
  const details = () =>
    [
      `${props.inspection.notes} ${props.inspection.notes === 1 ? "note" : "notes"}`,
      props.inspection.singers > 1 ? `Duet` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <>
      <div class="flex items-center gap-3 rounded-[10px] border border-popover-line bg-popover-well/50 p-3">
        <span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-soft text-violet">
          <FileMusicIcon class="size-5" />
        </span>
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="truncate text-[12.5px] font-medium text-foreground" data-testid="song-title">
            {props.inspection.artist || "Unknown artist"} · {props.inspection.title || "Untitled"}
          </span>
          <span class="truncate font-mono text-[10.5px] text-popover-muted" title={props.inspection.folder}>
            {details()} · {props.inspection.chart}
          </span>
        </div>
      </div>

      <Show when={props.inspection.charts.length > 1}>
        <div class="flex flex-col gap-1.5">
          <span id="song-chart" class="text-[10px] leading-none text-sage-68">
            Chart
          </span>
          <Select
            value={props.inspection.chart}
            disabled={props.locked}
            onValueChange={(value: unknown) => {
              if (typeof value === "string" && value !== props.inspection.chart) props.onChart(value);
            }}
          >
            <SelectTrigger class="w-full" aria-labelledby="song-chart">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <For each={props.inspection.charts}>{(chart) => <SelectItem value={chart}>{chart}</SelectItem>}</For>
            </SelectContent>
          </Select>
        </div>
      </Show>

      <ul
        aria-label="Song files"
        class="m-0 flex list-none flex-col divide-y divide-popover-line overflow-hidden rounded-[10px] border border-popover-line bg-popover-well/50 p-0"
      >
        <li class="flex items-center gap-3 px-3 py-2.5 text-[11.5px]">
          <CheckIcon class="size-4 text-primary" stroke-width={2.2} />
          <span class="w-[88px] text-popover-muted">Chart</span>
          <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-popover-foreground">
            {props.inspection.chart}
          </span>
        </li>
        <For each={props.inspection.media}>
          {(file) => (
            <li class="flex items-center gap-3 px-3 py-2.5 text-[11.5px]" data-testid="song-file">
              <Show
                when={file.found}
                fallback={
                  file.role === "audio" ? (
                    <TriangleAlertIcon class="size-4 text-destructive" />
                  ) : (
                    <CircleDashedIcon class="size-4 text-faint-foreground" />
                  )
                }
              >
                <CheckIcon class="size-4 text-primary" stroke-width={2.2} />
              </Show>
              <span class="w-[88px] text-popover-muted">{ROLE_LABELS[file.role]}</span>
              <span
                class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-popover-foreground"
                title={file.fileName}
              >
                {file.fileName}
              </span>
              <span class="shrink-0 font-mono text-[10.5px] text-popover-muted">
                {file.found && file.size !== undefined ? formatFileSize(file.size) : "Missing"}
              </span>
            </li>
          )}
        </For>
      </ul>

      <Show when={video()}>
        {(file) => (
          <div class="flex items-center justify-between gap-3 rounded-lg border border-input bg-field px-3 py-2">
            <div class="flex flex-col gap-0.5">
              <Label for="include-video">Include video</Label>
              <span class="text-[10.5px] text-popover-muted">
                Adds {formatFileSize(file().size ?? 0)} to the project. Leave it out to keep the file small.
              </span>
            </div>
            <Toggle
              id="include-video"
              size="sm"
              checked={props.includeVideo}
              disabled={props.locked}
              onCheckedChange={(checked: boolean) => props.onIncludeVideo(checked)}
              data-testid="include-video"
            />
          </div>
        )}
      </Show>

      <Show when={props.inspection.blocker}>
        {(blocker) => (
          <Note tone="error" testid="song-blocker">
            {blocker()}
          </Note>
        )}
      </Show>
      <Show when={props.inspection.warnings.length > 0}>
        <Note tone="warning" testid="song-warnings">
          <ul class="m-0 flex list-none flex-col gap-1 p-0">
            <For each={props.inspection.warnings}>{(warning) => <li>{warning}</li>}</For>
          </ul>
        </Note>
      </Show>
    </>
  );
}

function ImportProgressBar(props: { progress: ImportProgress | null }) {
  const percent = () => {
    const progress = props.progress;
    if (!progress || progress.total === 0) return 0;
    return Math.min(100, Math.round((progress.done / progress.total) * 100));
  };
  return (
    <div class="flex flex-col gap-2" data-testid="song-import-progress">
      <div class="flex items-center justify-between text-[11px]">
        <span class="truncate text-popover-foreground" aria-live="polite">
          {props.progress?.step ?? "Creating the project…"}
        </span>
        <span class="font-mono text-[10.5px] text-popover-muted tabular-nums">{percent()}%</span>
      </div>
      <progress
        aria-label="Import progress"
        max="100"
        value={percent()}
        class="h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-sage-22 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-150"
      />
    </div>
  );
}

/** A warning or error note inside the dialog. */
export function Note(props: { tone: "warning" | "error"; testid: string; children: JSX.Element }) {
  return (
    <div
      role={props.tone === "error" ? "alert" : "note"}
      data-tone={props.tone}
      data-testid={props.testid}
      class="flex gap-3 rounded-[9px] border px-3.5 py-3 text-[11px] leading-[1.6] data-[tone=error]:border-stone-39 data-[tone=error]:bg-stone-19 data-[tone=error]:text-stone-85 data-[tone=warning]:border-amber-33 data-[tone=warning]:bg-warning-soft data-[tone=warning]:text-amber-73"
    >
      <Show when={props.tone === "error"} fallback={<TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-warning" />}>
        <OctagonAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
      </Show>
      <div class="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}
