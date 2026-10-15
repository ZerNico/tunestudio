import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import { cn } from "~/lib/utils";

/** shadcn/ui Kbd, in the studio's mono keycap style. Inside tooltips it switches to the lime tint. */
export function Kbd(props: JSX.HTMLAttributes<HTMLElement>) {
  const rest = omit(props, "class");
  return (
    <kbd
      data-slot="kbd"
      class={cn(
        "pointer-events-none inline-flex w-fit items-center justify-center gap-1 rounded-[4px] border border-gray-27 bg-gray-15 px-[5px] py-[2px] font-mono text-[10px]/[1.4] whitespace-nowrap text-subtle-foreground select-none empty:hidden",
        "in-data-[slot=tooltip-content]:border-sage-38 in-data-[slot=tooltip-content]:bg-sage-14 in-data-[slot=tooltip-content]:px-1 in-data-[slot=tooltip-content]:py-0 in-data-[slot=tooltip-content]:text-[9px] in-data-[slot=tooltip-content]:text-primary-text",
        props.class as string,
      )}
      {...rest}
    />
  );
}

export function KbdGroup(props: JSX.HTMLAttributes<HTMLElement>) {
  const rest = omit(props, "class");
  return <kbd data-slot="kbd-group" class={cn("inline-flex items-center gap-1", props.class as string)} {...rest} />;
}
