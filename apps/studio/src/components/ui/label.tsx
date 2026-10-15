import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import { cn } from "~/lib/utils";

/**
 * shadcn/ui Label. Used as a wrapping label: caption text first, then the control. `stacked`
 * puts the caption above a full-width control.
 */
export function Label(props: JSX.LabelHTMLAttributes<HTMLLabelElement> & { layout?: "inline" | "stacked" }) {
  const rest = omit(props, "class", "layout");
  return (
    <label
      data-slot="label"
      data-layout={props.layout ?? "inline"}
      class={cn(
        "flex items-center gap-2 text-[10px] leading-none text-sage-68 select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 data-[layout=stacked]:flex-col data-[layout=stacked]:items-stretch data-[layout=stacked]:gap-1.5",
        props.class as string,
      )}
      {...rest}
    />
  );
}
