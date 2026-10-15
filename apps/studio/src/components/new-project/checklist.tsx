import { For, Match, Show, Switch } from "solid-js";
import CheckIcon from "~icons/lucide/check";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { formatFileSize } from "~/lib/format";
import type { ImportProgress } from "~/lib/native/types";

import { percentOf, progressBarClass } from "./progress";

/** How far the current task is, in words: a percentage, or bytes of a download. Nothing before it has started. */
function figure(progress: ImportProgress | null): string | null {
  if (!progress || progress.total <= 0) return null;
  if (progress.unit === "percent") return progress.done > 0 ? `${percentOf(progress)}%` : null;
  return `${formatFileSize(progress.done)} of ${formatFileSize(progress.total)}`;
}

/**
 * A job's tasks, each ticked off as main moves past it, the current one with its progress (a moving bar while it can't
 * say how far it is).
 */
export function Checklist(props: {
  title: string;
  hint: string;
  /** The list's accessible name. */
  label: string;
  testid: string;
  tasks: string[];
  progress: ImportProgress | null;
}) {
  const current = () => Math.max(0, props.tasks.indexOf(props.progress?.step ?? props.tasks[0]!));
  const value = () => (figure(props.progress) === null ? undefined : percentOf(props.progress));
  return (
    <div class="flex flex-col gap-1">
      <p class="m-0 text-[13px] font-semibold text-foreground">{props.title}</p>
      <p class="m-0 mb-2 text-[11px] text-popover-muted">{props.hint}</p>
      <ol
        aria-label={props.label}
        class="m-0 flex list-none flex-col gap-3 rounded-[10px] border border-popover-line bg-popover-well/50 p-3.5"
        data-testid={props.testid}
      >
        <For each={props.tasks}>
          {(task, index) => (
            <li
              data-state={index() < current() ? "done" : index() === current() ? "active" : "waiting"}
              class="flex items-start gap-2.5 text-[11.5px] text-popover-foreground data-[state=waiting]:text-popover-muted"
            >
              <span class="mt-px flex size-4 shrink-0 items-center justify-center">
                <Switch fallback={<span class="size-4 rounded-full border border-popover-line" />}>
                  <Match when={index() < current()}>
                    <span class="flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <CheckIcon class="size-3" stroke-width={3} />
                    </span>
                  </Match>
                  <Match when={index() === current()}>
                    {/* The icon's ring is 18 of its 24 units: at 21px it is as wide as the 16px ticks. */}
                    <LoaderCircleIcon class="size-[21px] shrink-0 animate-spin text-primary" />
                  </Match>
                </Switch>
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <span class="flex items-baseline justify-between gap-3">
                  {task}
                  <Show when={index() === current() && figure(props.progress)}>
                    {(text) => <span class="font-mono text-[10.5px] text-popover-muted tabular-nums">{text()}</span>}
                  </Show>
                </span>
                <Show when={index() === current()}>
                  <progress aria-label={`${task} progress`} max="100" value={value()} class={progressBarClass} />
                </Show>
              </div>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}
