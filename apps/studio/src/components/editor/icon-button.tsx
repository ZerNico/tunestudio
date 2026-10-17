/**
 * The editor's icon buttons: an icon with its name (and key) in our tooltip, the key also on the button while the key
 * hints show (`KeyHint`). A toggle says whether it is on (`pressed`, drawn filled); others leave `pressed` out and say
 * what they do in their label (Mute).
 */
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { keyHintsShown } from "~/lib/editor/key-hints";

/**
 * A button's key while Cmd (Ctrl) is held (`key-hints.ts`): just past its edge, below it (the title bar) or above it
 * (the bottom bar), so it covers the space beside the button rather than the button. Its button is `relative`.
 */
export function KeyHint(props: { keys: string | undefined; side?: "below" | "above" }) {
  return (
    <Show when={keyHintsShown() && props.keys}>
      <span
        class="pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 rounded-[4px] shadow-md data-[side=above]:bottom-full data-[side=above]:mb-1 data-[side=below]:top-full data-[side=below]:mt-1"
        data-side={props.side ?? "below"}
        data-testid="key-hint"
      >
        <Kbd>{props.keys}</Kbd>
      </span>
    </Show>
  );
}

export function IconButton(props: {
  /** The button's name (for screen readers, and the tooltip unless `tooltip` says more). */
  label: string;
  tooltip?: string;
  shortcut?: string;
  /** Where its key hint goes: below (the default) or above (in the bottom bar). */
  hintSide?: "below" | "above";
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
            class="relative"
            variant={props.pressed ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={props.label}
            aria-pressed={props.pressed === undefined ? undefined : props.pressed ? "true" : "false"}
            disabled={props.disabled}
            onClick={() => props.onClick()}
            data-testid={props.testid}
          >
            {props.children}
            <KeyHint keys={props.shortcut} side={props.hintSide} />
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
