/** The editor's controls in the title bar: Undo and Redo, the tools, and auto pitch. */
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import LoaderCircleIcon from "~icons/lucide/loader-circle";
import MousePointer2Icon from "~icons/lucide/mouse-pointer-2";
import PencilIcon from "~icons/lucide/pencil";
import ScissorsIcon from "~icons/lucide/scissors";
import SquareIcon from "~icons/lucide/square";
import WandSparklesIcon from "~icons/lucide/wand-sparkles";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { type Tool, TOOLS } from "~/lib/editor/tools";

/** Undo or Redo: says what it would do ("Undo Move note"), disabled when there is nothing. */
export function HistoryButton(props: {
  label: string | null;
  action: "Undo" | "Redo";
  onClick: () => void;
  testid: string;
  children: JSX.Element;
}) {
  const text = () => (props.label ? `${props.action} ${props.label}` : props.action);
  return (
    <Tooltip>
      <TooltipTrigger
        render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
          // The trigger's props go first: its own click handler would replace the button's.
          <Button
            {...triggerProps}
            variant="ghost"
            size="icon-sm"
            aria-label={text()}
            disabled={!props.label}
            onClick={() => props.onClick()}
            data-testid={props.testid}
          >
            {props.children}
          </Button>
        )}
      />
      <TooltipContent>{text()}</TooltipContent>
    </Tooltip>
  );
}

const TOOL_ICONS: Record<Tool, (props: { class?: string }) => JSX.Element> = {
  select: MousePointer2Icon,
  draw: PencilIcon,
  split: ScissorsIcon,
};

/** The tools as icons; each tooltip names it and its key. */
export function ToolSwitch(props: { tool: Tool; onTool: (tool: Tool) => void }) {
  return (
    <ToggleGroup
      variant="segment"
      size="segment-icon"
      spacing={0.5}
      aria-label="Tool"
      value={[props.tool]}
      onValueChange={(value: unknown[]) => {
        const next = TOOLS.find((entry) => entry.tool === value[0]);
        if (next) props.onTool(next.tool);
      }}
      data-testid="tools"
    >
      <For each={TOOLS}>
        {(entry) => {
          const Icon = TOOL_ICONS[entry.tool];
          return (
            <Tooltip>
              <TooltipTrigger
                render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
                  <ToggleGroupItem
                    value={entry.tool}
                    aria-label={entry.label}
                    data-testid={`tool-${entry.tool}`}
                    {...triggerProps}
                  >
                    <Icon />
                  </ToggleGroupItem>
                )}
              />
              <TooltipContent>
                {entry.label} <Kbd>{entry.key}</Kbd>
              </TooltipContent>
            </Tooltip>
          );
        }}
      </For>
    </ToggleGroup>
  );
}

/**
 * Auto pitch for the selected notes (also A and the note menu). While it works the button shows how far it is and
 * stops it.
 */
export function AutoPitchButton(props: {
  /** What it is doing (undefined: not working; null: started, no progress yet). */
  status: string | null | undefined;
  percent: number | null;
  canStart: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <Show
      when={props.status !== undefined}
      fallback={
        <Tooltip>
          <TooltipTrigger
            render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
              <Button
                {...triggerProps}
                variant="ghost"
                size="icon-sm"
                aria-label="Auto pitch"
                disabled={!props.canStart}
                onClick={() => props.onStart()}
                data-testid="auto-pitch"
              >
                <WandSparklesIcon />
              </Button>
            )}
          />
          <TooltipContent>
            Auto pitch the selected notes <Kbd>A</Kbd>
          </TooltipContent>
        </Tooltip>
      }
    >
      <Tooltip>
        <TooltipTrigger
          render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
            <Button
              {...triggerProps}
              variant="ghost"
              size="sm"
              class="group text-muted-foreground"
              aria-label="Stop auto pitch"
              onClick={() => props.onStop()}
              data-testid="auto-pitch-status"
            >
              <LoaderCircleIcon class="animate-spin text-primary group-hover:hidden" />
              <SquareIcon class="hidden fill-current group-hover:block" />
              {/* Only the step is announced, not every percent. */}
              <span aria-live="polite">{props.status ?? "Finding the pitch"}</span>
              <Show when={props.percent !== null}>
                <span class="tabular-nums">{Math.round(props.percent!)}%</span>
              </Show>
            </Button>
          )}
        />
        <TooltipContent>Stop auto pitch</TooltipContent>
      </Tooltip>
    </Show>
  );
}
