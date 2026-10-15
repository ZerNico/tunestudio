import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";

import { cn } from "~/lib/utils";

/** shadcn/ui Textarea: the Input's field well, for several lines of text. */
export function Textarea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const rest = omit(props, "class");
  return (
    <textarea
      data-slot="textarea"
      class={cn(
        "field-sizing-content min-h-16 w-full min-w-0 resize-none rounded-lg border border-input bg-field px-2.5 py-2 text-[12px] leading-[1.6] text-foreground transition-colors outline-none placeholder:text-muted-foreground hover:border-slate-36 focus:border-lime-59 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        props.class as string,
      )}
      {...rest}
    />
  );
}
