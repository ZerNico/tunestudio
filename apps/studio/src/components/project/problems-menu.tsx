import type { JSX } from "@solidjs/web";
import { For, omit, Show } from "solid-js";
import CheckIcon from "~icons/lucide/check";
import TriangleAlertIcon from "~icons/lucide/triangle-alert";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import type { ChartProblem } from "~/lib/editor/checks";
import { formatTime } from "~/lib/editor/view";

const pillClass =
  "flex h-[22px] items-center gap-1 rounded-[11px] border px-1.5 font-mono text-[10px] [&>svg]:size-3.5";

/** The pill while nothing is wrong. */
function CleanPill(props: JSX.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...props} class={`${pillClass} border-sage-23-2 text-lime-64`}>
      <CheckIcon />
    </span>
  );
}

/** The pill that opens the problems, with how many there are. */
function ProblemsPill(props: JSX.HTMLAttributes<HTMLButtonElement> & { count: number }) {
  const rest = omit(props, "count");
  return (
    <button
      type="button"
      {...rest}
      class={`${pillClass} cursor-pointer border-amber-33 bg-warning-soft text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring`}
    >
      <TriangleAlertIcon />
      {props.count}
    </button>
  );
}

/**
 * The chart's problems in the title bar: a check mark while there are none, else a warning with how many, opening a
 * list of them by time; choosing one shows it (`onShow`).
 */
export function ProblemsMenu(props: { problems: readonly ChartProblem[]; onShow: (problem: ChartProblem) => void }) {
  const count = () => props.problems.length;
  return (
    <Show
      when={count() > 0}
      fallback={
        <Tooltip>
          <TooltipTrigger
            render={(triggerProps: JSX.HTMLAttributes<HTMLSpanElement>) => (
              <CleanPill {...triggerProps} aria-label="No problems found" data-testid="problems" />
            )}
          />
          <TooltipContent>No problems found</TooltipContent>
        </Tooltip>
      }
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
            <ProblemsPill
              {...triggerProps}
              count={count()}
              aria-label={`${count()} ${count() === 1 ? "problem" : "problems"}`}
              data-testid="problems"
            />
          )}
        />
        <DropdownMenuContent align="start" class="min-w-[260px]" data-testid="problems-menu">
          <For each={props.problems} keyed={(problem) => problem.key}>
            {(problem) => (
              <DropdownMenuItem onClick={() => props.onShow(problem())} data-testid="problem">
                <TriangleAlertIcon class="text-warning!" />
                <span class="flex-1">{problem().message}</span>
                <span class="font-mono text-[10px] text-muted-foreground tabular-nums">
                  {formatTime(problem().start)}
                </span>
              </DropdownMenuItem>
            )}
          </For>
        </DropdownMenuContent>
      </DropdownMenu>
    </Show>
  );
}
