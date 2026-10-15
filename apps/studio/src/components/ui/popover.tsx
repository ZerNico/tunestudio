import type { JSX } from "@solidjs/web";
import { Popover as PopoverPrimitive } from "base-ui-solid/popover";
import { omit } from "solid-js";

import { cn, stateClass } from "~/lib/utils";

/** shadcn/ui Popover (Base UI variant) on base-ui-solid. */
export function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}
export function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

export type PopoverContentProps = PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">;

export function PopoverContent(props: PopoverContentProps) {
  const rest = omit(props, "class", "side", "sideOffset", "align", "alignOffset");
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={props.align ?? "center"}
        alignOffset={props.alignOffset ?? 0}
        side={props.side ?? "bottom"}
        sideOffset={props.sideOffset ?? 4}
        class="isolate z-[110]"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          class={(state) =>
            cn(
              "z-50 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg border border-popover-border bg-popover p-2.5 text-[11px] text-popover-foreground shadow-[0_10px_40px_#0009] outline-hidden duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              stateClass(props.class, state),
            )
          }
          {...rest}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export function PopoverHeader(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const rest = omit(props, "class");
  return (
    <div data-slot="popover-header" class={cn("flex flex-col gap-0.5 text-[11px]", props.class as string)} {...rest} />
  );
}
export function PopoverTitle(props: PopoverPrimitive.Title.Props) {
  const rest = omit(props, "class");
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      class={(state) => cn("font-medium", stateClass(props.class, state))}
      {...rest}
    />
  );
}
export function PopoverDescription(props: PopoverPrimitive.Description.Props) {
  const rest = omit(props, "class");
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      class={(state) => cn("text-popover-muted", stateClass(props.class, state))}
      {...rest}
    />
  );
}
