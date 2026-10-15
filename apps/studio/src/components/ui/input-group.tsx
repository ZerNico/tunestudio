import type { JSX } from "@solidjs/web";
import { cva, type VariantProps } from "class-variance-authority";
import { omit } from "solid-js";

import { cn } from "~/lib/utils";

/**
 * shadcn/ui InputGroup, trimmed: a field well holding an input with addons (icons, hints,
 * buttons) on either side. The well takes the input's focus ring and invalid state.
 */
export const inputGroupVariants = cva(
  "group/input-group relative flex w-full min-w-0 items-center rounded-lg border border-input bg-field text-foreground transition-colors hover:border-slate-36 has-disabled:opacity-50 has-[input:focus-visible]:border-lime-59 has-[input:focus-visible]:shadow-[0_0_0_3px_#b5e7771a] has-[input[aria-invalid=true]]:border-destructive",
  {
    variants: {
      size: {
        default: "h-7 text-[11px]",
        lg: "h-9 text-[12px]",
      },
    },
    defaultVariants: { size: "default" },
  },
);

export type InputGroupProps = JSX.HTMLAttributes<HTMLDivElement> & VariantProps<typeof inputGroupVariants>;

export function InputGroup(props: InputGroupProps) {
  const rest = omit(props, "class", "size");
  return (
    <div
      data-slot="input-group"
      class={cn(inputGroupVariants({ size: props.size }), props.class as string)}
      {...rest}
    />
  );
}

export function InputGroupInput(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const rest = omit(props, "class");
  return (
    <input
      data-slot="input-group-control"
      class={cn(
        "h-full w-full min-w-0 flex-1 border-0 bg-transparent px-2.5 text-inherit outline-none placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed",
        props.class as string,
      )}
      {...rest}
    />
  );
}

export function InputGroupAddon(props: JSX.HTMLAttributes<HTMLDivElement> & { align?: "start" | "end" }) {
  const rest = omit(props, "class", "align");
  return (
    <div
      data-slot="input-group-addon"
      data-align={props.align ?? "start"}
      class={cn(
        "flex shrink-0 items-center gap-1.5 text-sage-63 select-none data-[align=end]:pr-1 data-[align=start]:pl-2.5 [&>svg:not([class*='size-'])]:size-3.5",
        props.class as string,
      )}
      {...rest}
    />
  );
}
