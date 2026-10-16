import type { JSX } from "@solidjs/web";
import { Dialog as DialogPrimitive } from "base-ui-solid/dialog";
import { Show, omit } from "solid-js";
import XIcon from "~icons/lucide/x";

import { cn, stateClass } from "~/lib/utils";

import { Button } from "./button";

/**
 * shadcn/ui Dialog (Base UI variant) on base-ui-solid. Studio look: green-tinted popover
 * surface, 13px radius, blurred dark backdrop, header and footer separated by hairlines.
 */
export function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}
export function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}
export function DialogPortal(props: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}
export function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

export function DialogOverlay(props: DialogPrimitive.Backdrop.Props) {
  const rest = omit(props, "class");
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      class={(state) =>
        cn(
          "fixed inset-0 isolate z-[100] bg-gray-2-a72 backdrop-blur-[5px] duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
          stateClass(props.class, state),
        )
      }
      {...rest}
    />
  );
}

export type DialogContentProps = DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  /** Accessible name of the close button. */
  closeLabel?: string;
};

export function DialogContent(props: DialogContentProps) {
  const rest = omit(props, "class", "children", "showCloseButton", "closeLabel");
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        class={(state) =>
          cn(
            "fixed top-1/2 left-1/2 z-[101] max-h-[calc(100dvh-50px)] w-[min(540px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 scrollbar-thin overflow-auto rounded-[13px] border border-popover-border bg-popover text-popover-foreground shadow-[0_32px_120px_#000a] transition-[filter] duration-100 outline-none data-nested-dialog-open:brightness-[.55] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[.98] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[.98]",
            stateClass(props.class, state),
          )
        }
        {...rest}
      >
        <Show when={props.showCloseButton !== false}>
          <DialogPrimitive.Close
            data-slot="dialog-close"
            aria-label={props.closeLabel ?? "Close dialog"}
            render={(p) => <Button variant="ghost" size="icon-sm" {...p} class="absolute top-[25px] right-[25px]" />}
          >
            <XIcon />
          </DialogPrimitive.Close>
        </Show>
        {props.children}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

export function DialogHeader(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const rest = omit(props, "class");
  return (
    <div
      data-slot="dialog-header"
      class={cn(
        "flex flex-col gap-[9px] border-b border-popover-line px-[25px] pt-[25px] pr-16 pb-5",
        props.class as string,
      )}
      {...rest}
    />
  );
}

export function DialogBody(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const rest = omit(props, "class");
  return (
    <div data-slot="dialog-body" class={cn("flex flex-col gap-4 px-[25px] py-5", props.class as string)} {...rest} />
  );
}

export function DialogFooter(props: JSX.HTMLAttributes<HTMLDivElement>) {
  const rest = omit(props, "class");
  return (
    <div
      data-slot="dialog-footer"
      class={cn(
        "flex justify-end gap-[9px] rounded-b-[13px] border-t border-popover-line bg-sage-11 px-[25px] py-[17px]",
        props.class as string,
      )}
      {...rest}
    />
  );
}

export function DialogTitle(props: DialogPrimitive.Title.Props) {
  const rest = omit(props, "class");
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      class={(state) => cn("m-0 text-[21px] leading-[1.3] font-[550] tracking-[-.6px]", stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function DialogDescription(props: DialogPrimitive.Description.Props) {
  const rest = omit(props, "class");
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      class={(state) => cn("m-0 text-[11px] leading-[1.8] text-popover-muted", stateClass(props.class, state))}
      {...rest}
    />
  );
}
