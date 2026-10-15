import type { JSX } from "@solidjs/web";
import { cva, type VariantProps } from "class-variance-authority";
import { omit } from "solid-js";

import { cn } from "~/lib/utils";

/**
 * shadcn/ui Input: dark field well, lime focus border.
 * Renders a native `<input>` (like shadcn's Radix variant) rather than base-ui-solid's `Input`:
 * Base UI's Input treats `value` as controlled (as upstream does), while the editor binds `value`
 * one-way and commits on `change`, which needs the native uncontrolled behaviour.
 */
export const inputVariants = cva(
  "w-full min-w-0 rounded-lg border border-input bg-field text-foreground transition-colors outline-none placeholder:text-muted-foreground hover:border-slate-36 focus:border-lime-59 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
  {
    variants: {
      size: {
        default: "h-7 px-2 py-[5px] text-[11px]",
        lg: "h-9 px-2.5 text-[12px]",
        bare: "h-auto border-0 bg-transparent p-0 hover:border-0 focus:border-0",
      },
    },
    defaultVariants: { size: "default" },
  },
);

export type InputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "size"> & VariantProps<typeof inputVariants>;

export function Input(props: InputProps) {
  const rest = omit(props, "class", "size");
  return <input data-slot="input" class={cn(inputVariants({ size: props.size }), props.class as string)} {...rest} />;
}
