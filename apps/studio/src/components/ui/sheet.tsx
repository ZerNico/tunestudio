import type { JSX } from "@solidjs/web";
import { Dialog as SheetPrimitive } from "base-ui-solid/dialog";
import { Show, omit } from "solid-js";
import XIcon from "~icons/lucide/x";

import { cn, stateClass } from "~/lib/utils";

import { Button } from "./button";

/**
 * shadcn/ui Sheet (Base UI variant): a modal side panel on base-ui-solid's Dialog
 * (focus trap, Escape/outside dismissal, focus return to the opener).
 */
export function Sheet(props: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}
export function SheetTrigger(props: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}
export function SheetClose(props: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}
export function SheetPortal(props: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

export function SheetOverlay(props: SheetPrimitive.Backdrop.Props) {
  const rest = omit(props, "class");
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      class={(state) =>
        cn(
          "fixed inset-0 z-[100] bg-gray-2-a60 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0",
          stateClass(props.class, state),
        )
      }
      {...rest}
    />
  );
}

export type SheetContentProps = SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left";
  showCloseButton?: boolean;
  closeLabel?: string;
};

export function SheetContent(props: SheetContentProps) {
  const rest = omit(props, "class", "children", "side", "showCloseButton", "closeLabel");
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={props.side ?? "right"}
        class={(state) =>
          cn(
            "fixed z-[101] flex flex-col bg-gray-12 text-popover-foreground shadow-[-24px_0_80px_#0009] transition-transform duration-[180ms] ease-out outline-none",
            "data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:w-[min(380px,100vw)] data-[side=right]:border-l data-[side=right]:border-sage-29 data-[side=right]:data-ending-style:translate-x-full data-[side=right]:data-starting-style:translate-x-full",
            "data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:w-[min(380px,100vw)] data-[side=left]:border-r data-[side=left]:border-sage-29 data-[side=left]:data-ending-style:-translate-x-full data-[side=left]:data-starting-style:-translate-x-full",
            "data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:border-b data-[side=top]:data-ending-style:-translate-y-full data-[side=top]:data-starting-style:-translate-y-full",
            "data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-full data-[side=bottom]:data-starting-style:translate-y-full",
            stateClass(props.class, state),
          )
        }
        {...rest}
      >
        <Show when={props.showCloseButton !== false}>
          <SheetPrimitive.Close
            data-slot="sheet-close"
            aria-label={props.closeLabel ?? "Close panel"}
            render={(p) => <Button variant="ghost" size="icon-sm" {...p} class="absolute top-4 right-[18px]" />}
          >
            <XIcon class="size-4" />
          </SheetPrimitive.Close>
        </Show>
        {props.children}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

export function SheetHeader(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const rest = omit(props, "class");
  return (
    <div
      data-slot="sheet-header"
      class={cn("flex flex-col gap-1 border-b border-sage-23-2 px-[18px] pt-4 pr-14 pb-3", props.class as string)}
      {...rest}
    />
  );
}
export function SheetFooter(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const rest = omit(props, "class");
  return (
    <div data-slot="sheet-footer" class={cn("mt-auto flex flex-col gap-2 p-4", props.class as string)} {...rest} />
  );
}
export function SheetTitle(props: SheetPrimitive.Title.Props) {
  const rest = omit(props, "class");
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      class={(state) =>
        cn("m-0 text-[16px] font-[550] tracking-[-.3px] text-foreground", stateClass(props.class, state))
      }
      {...rest}
    />
  );
}
export function SheetDescription(props: SheetPrimitive.Description.Props) {
  const rest = omit(props, "class");
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      class={(state) => cn("m-0 text-[11px] text-sage-64", stateClass(props.class, state))}
      {...rest}
    />
  );
}
