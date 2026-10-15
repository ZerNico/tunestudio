import { Button as ButtonPrimitive } from "base-ui-solid/button";
import { cva, type VariantProps } from "class-variance-authority";
import { omit } from "solid-js";

import { cn, stateClass } from "~/lib/utils";

/**
 * shadcn/ui Button (Base UI variant, base-nova), ported to base-ui-solid and tuned to the
 * studio's compact density: 11px labels, 34px default height, lime primary.
 */
export const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-transparent bg-clip-padding text-[11px] font-semibold whitespace-nowrap transition-[background-color,color,border-color,box-shadow] duration-100 select-none disabled:pointer-events-none disabled:opacity-35 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-primary bg-primary text-primary-foreground shadow-[0_1px_1px_#0003] hover:bg-[color-mix(in_oklab,var(--primary),white_22%)]",
        outline:
          "border-input bg-transparent text-secondary-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted",
        secondary:
          "border-slate-27 bg-secondary text-secondary-foreground hover:border-sage-39 hover:bg-slate-23 hover:text-white aria-expanded:bg-slate-23",
        ghost: "text-sage-73 hover:bg-accent hover:text-white aria-expanded:bg-accent aria-expanded:text-white",
        destructive: "border-rust-47 bg-rust-31 text-foreground hover:bg-rust-35 hover:text-white",
        link: "h-auto gap-[7px] p-0 font-normal text-sage-73 hover:text-primary",
        assist:
          "border-violet-line bg-violet-soft text-violet-text hover:border-violet-38 hover:bg-violet-22 hover:text-white",
      },
      size: {
        default: "min-h-[34px] px-3 py-2",
        sm: "h-7 gap-1.5 px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-[22px] gap-1 rounded-[5px] px-[7px] text-[10px] font-normal [&_svg:not([class*='size-'])]:size-3",
        lg: "h-9 px-3.5",
        icon: "size-8 font-normal [&_svg:not([class*='size-'])]:size-[18px]",
        "icon-sm": "size-[26px] font-normal [&_svg:not([class*='size-'])]:size-[18px]",
        "icon-xs": "size-[18px] rounded-[4px] font-normal [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-9 font-normal [&_svg:not([class*='size-'])]:size-[18px]",
      },
    },
    compoundVariants: [
      {
        variant: "ghost",
        size: ["icon", "icon-sm", "icon-xs", "icon-lg"],
        class: "text-sage-67-2 hover:text-accent-foreground",
      },
      { variant: "link", size: ["default", "sm", "xs", "lg"], class: "h-auto min-h-0 p-0" },
    ],
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

export function Button(props: ButtonProps) {
  const rest = omit(props, "class", "variant", "size");
  return (
    <ButtonPrimitive
      data-slot="button"
      class={(state) =>
        cn(buttonVariants({ variant: props.variant, size: props.size }), stateClass(props.class, state))
      }
      {...rest}
    />
  );
}
