import { Tooltip as TooltipPrimitive } from "base-ui-solid/tooltip";
import { omit } from "solid-js";

import { cn, stateClass } from "~/lib/utils";

/**
 * shadcn/ui Tooltip (Base UI variant) on base-ui-solid. Differences from base-nova: the studio's
 * dark tooltip surface instead of the inverted foreground one, no arrow, a 450 ms provider delay.
 */
export function TooltipProvider(props: TooltipPrimitive.Provider.Props) {
  const rest = omit(props, "delay", "closeDelay");
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={props.delay ?? 450}
      closeDelay={props.closeDelay ?? 0}
      {...rest}
    />
  );
}

export function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

export function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export type TooltipContentProps = TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">;

export function TooltipContent(props: TooltipContentProps) {
  const rest = omit(props, "class", "side", "sideOffset", "align", "alignOffset", "children");
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={props.align ?? "center"}
        alignOffset={props.alignOffset ?? 0}
        side={props.side ?? "bottom"}
        sideOffset={props.sideOffset ?? 6}
        class="pointer-events-none isolate z-[120]"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          class={(state) =>
            cn(
              "z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-2 rounded-[5px] border border-tooltip-border bg-tooltip px-2 py-[5px] text-[11px] whitespace-nowrap text-sage-91 shadow-[0_6px_20px_#0008] transition-[opacity,scale] duration-100 data-ending-style:scale-96 data-ending-style:opacity-0 data-instant:transition-none data-starting-style:scale-96 data-starting-style:opacity-0",
              stateClass(props.class, state),
            )
          }
          {...rest}
        >
          {props.children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
