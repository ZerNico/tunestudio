import { ScrollArea as ScrollAreaPrimitive } from "base-ui-solid/scroll-area";
import { omit } from "solid-js";

import { cn, stateClass } from "~/lib/utils";

/** shadcn/ui ScrollArea (Base UI variant) on base-ui-solid, with the studio's thin green-grey thumb. */
export function ScrollArea(
  props: ScrollAreaPrimitive.Root.Props & { viewportRef?: (element: HTMLDivElement) => void; viewportClass?: string },
) {
  const rest = omit(props, "class", "children", "viewportRef", "viewportClass");
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      class={(state) => cn("relative min-h-0 overflow-hidden", stateClass(props.class, state))}
      {...rest}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        ref={props.viewportRef}
        class={cn(
          "size-full overscroll-contain rounded-[inherit] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          props.viewportClass,
        )}
      >
        {props.children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

export function ScrollBar(props: ScrollAreaPrimitive.Scrollbar.Props) {
  const rest = omit(props, "class", "orientation");
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={props.orientation ?? "vertical"}
      class={(state) =>
        cn(
          "flex touch-none p-px opacity-0 transition-opacity select-none data-hovering:opacity-100 data-scrolling:opacity-100 data-horizontal:h-2 data-horizontal:flex-col data-vertical:h-full data-vertical:w-2",
          stateClass(props.class, state),
        )
      }
      {...rest}
    >
      <ScrollAreaPrimitive.Thumb data-slot="scroll-area-thumb" class="relative flex-1 rounded-full bg-sage-30-2" />
    </ScrollAreaPrimitive.Scrollbar>
  );
}
