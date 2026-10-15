import type { JSX } from "@solidjs/web";
import { Toast as ToastPrimitive } from "base-ui-solid/toast";
import { For, Show } from "solid-js";
import CircleCheckIcon from "~icons/lucide/circle-check";
import InfoIcon from "~icons/lucide/info";
import TriangleAlertIcon from "~icons/lucide/triangle-alert";
import XIcon from "~icons/lucide/x";

import { cn } from "~/lib/utils";

import { buttonVariants } from "./button";

/**
 * Toasts on base-ui-solid's Toast, in the studio's notification style (dark green surface,
 * bottom centre). Show one from anywhere with `toast.add({ title, description, type })`;
 * `type` is "success", "info" (default) or "error".
 */
export const toast = ToastPrimitive.createToastManager();

export function Toaster(props: { children?: JSX.Element }) {
  return (
    <ToastPrimitive.Provider toastManager={toast} limit={3}>
      {props.children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport
          data-slot="toaster"
          class="fixed bottom-6 left-1/2 z-[130] flex w-[min(460px,calc(100vw-32px))] -translate-x-1/2 flex-col-reverse gap-2 outline-none"
        >
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

function ToastList() {
  const manager = ToastPrimitive.useToastManager();
  return (
    <For each={manager.toasts}>
      {(item) => (
        <ToastPrimitive.Root
          toast={item}
          data-slot="toast"
          class={(state) =>
            cn(
              // While swiping, Base UI moves the toast with an inline transform and keeps the offset in
              // --toast-swipe-movement-x/y; the toast's own transform must use them too, so letting go
              // continues from where it was instead of snapping back to the middle.
              "flex [transform:translateX(var(--toast-swipe-movement-x,0px))_translateY(var(--toast-swipe-movement-y,0px))] items-start gap-3 rounded-[9px] border border-sage-42 bg-sage-20 py-3 pr-2 pl-4 text-[11px] leading-[1.6] text-sage-88 shadow-[0_10px_45px_#0008] transition-[opacity,translate,transform] duration-200 data-ending-style:opacity-0 data-ending-style:not-data-swipe-direction:translate-y-1.5 data-starting-style:translate-y-1.5 data-starting-style:opacity-0 data-ending-style:data-[swipe-direction=down]:[transform:translateX(var(--toast-swipe-movement-x,0px))_translateY(calc(var(--toast-swipe-movement-y,0px)+150%))] data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x,0px)+110%))_translateY(var(--toast-swipe-movement-y,0px))]",
              state.type === "error" && "border-stone-39 bg-stone-19 text-stone-85",
            )
          }
        >
          <span class="mt-px flex text-primary-text in-data-[type=error]:text-destructive [&>svg]:size-4">
            <Show when={item.type === "error"} fallback={item.type === "success" ? <CircleCheckIcon /> : <InfoIcon />}>
              <TriangleAlertIcon />
            </Show>
          </span>
          <ToastPrimitive.Content class="flex min-w-0 flex-1 flex-col gap-0.5">
            <ToastPrimitive.Title class="m-0 text-[12px] font-semibold text-foreground" />
            <ToastPrimitive.Description class="m-0" />
          </ToastPrimitive.Content>
          <Show when={item.actionProps}>
            <ToastPrimitive.Action class={cn(buttonVariants({ variant: "outline", size: "xs" }), "mt-px")} />
          </Show>
          <ToastPrimitive.Close
            aria-label="Dismiss notification"
            // Taller than a line of text: it overhangs the padding, so a one-line toast's text sits in the middle.
            class={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "-my-1")}
          >
            <XIcon class="size-3.5" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      )}
    </For>
  );
}
