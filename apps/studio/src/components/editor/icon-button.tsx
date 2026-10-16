/**
 * The editor's icon buttons: an icon with its name (and key) in our tooltip. A toggle says whether it is on
 * (`pressed`, drawn filled); others leave `pressed` out and say what they do in their label (Mute).
 */
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";

export function IconButton(props: {
  /** The button's name (for screen readers, and the tooltip unless `tooltip` says more). */
  label: string;
  tooltip?: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  testid: string;
  children: JSX.Element;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
          // The trigger's props go first: its own click handler would replace the button's.
          <Button
            {...triggerProps}
            variant={props.pressed ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={props.label}
            aria-pressed={props.pressed === undefined ? undefined : props.pressed ? "true" : "false"}
            disabled={props.disabled}
            onClick={() => props.onClick()}
            data-testid={props.testid}
          >
            {props.children}
          </Button>
        )}
      />
      <TooltipContent>
        {props.tooltip ?? props.label}
        <Show when={props.shortcut}>
          {" "}
          <Kbd>{props.shortcut}</Kbd>
        </Show>
      </TooltipContent>
    </Tooltip>
  );
}
