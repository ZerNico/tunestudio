import type { JSX } from "@solidjs/web";
import { cva, type VariantProps } from "class-variance-authority";
import { omit } from "solid-js";

import { cn } from "~/lib/utils";

/** shadcn/ui Badge: small mono counters and status tags (count pills, project status). */
export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[4px] border border-transparent whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary px-1.5 py-0.5 text-[9px] text-primary-foreground",
        secondary: "border-0 bg-gray-19 px-1.5 py-0.5 font-mono text-[9px] text-sage-73",
        outline: "rounded-[3px] border-sage-35-2 px-1 py-[3px] text-[6px] font-[650] tracking-[.8px] text-sage-65",
        warning: "bg-warning-soft px-1.5 py-0.5 text-[9px] text-warning",
        lime: "border-primary-line/70 bg-primary-soft px-1.5 py-0.5 text-[9.5px] font-medium text-primary-text",
        violet: "border-violet-line bg-violet-soft px-1.5 py-0.5 text-[9.5px] font-medium text-violet-text",
        caution: "border-amber-33 bg-warning-soft px-1.5 py-0.5 text-[9.5px] font-medium text-warning",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeProps = JSX.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge(props: BadgeProps) {
  const rest = omit(props, "class", "variant");
  return (
    <span data-slot="badge" class={cn(badgeVariants({ variant: props.variant }), props.class as string)} {...rest} />
  );
}
