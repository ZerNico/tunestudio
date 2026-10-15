import { Toggle as TogglePrimitive } from "base-ui-solid/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import { omit } from "solid-js";

import { cn, stateClass } from "~/lib/utils";

/** shadcn/ui Toggle (Base UI variant) on base-ui-solid. Pressed state uses the lime tint. */
export const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-lg border border-transparent whitespace-nowrap transition-[background-color,color,border-color] duration-100 select-none hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-35 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "text-sage-67-2 data-pressed:border-primary-line data-pressed:bg-primary-soft data-pressed:text-primary",
        outline:
          "border-gray-22 text-sage-57 hover:bg-gray-16 hover:text-sage-87 data-pressed:border-lime-38 data-pressed:bg-sage-18-2 data-pressed:text-lime-83-2",
        segment:
          "text-sage-63 hover:bg-transparent hover:text-white data-pressed:bg-sage-23-2 data-pressed:text-primary-text data-pressed:shadow-[inset_0_0_0_1px_#405040]",
        violet:
          "border-gray-22 text-sage-57 hover:bg-gray-16 hover:text-sage-87 data-pressed:border-violet-line data-pressed:bg-violet-soft data-pressed:text-violet-text",
      },
      size: {
        default: "size-8",
        sm: "size-[30px]",
        xs: "h-[22px] rounded-[5px] px-[7px] text-[10px] [&_svg:not([class*='size-'])]:size-3",
        segment: "h-7 gap-1.5 rounded-[6px] px-3 text-[11.5px] [&_svg:not([class*='size-'])]:size-3.5",
        /** An icon-only segment (the editor's tool strip). */
        "segment-icon": "size-7 rounded-[6px] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-[26px] gap-[5px] rounded-[5px] px-2 text-[10px] [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ToggleProps = TogglePrimitive.Props & VariantProps<typeof toggleVariants>;

export function Toggle(props: ToggleProps) {
  const rest = omit(props, "class", "variant", "size");
  return (
    <TogglePrimitive
      data-slot="toggle"
      class={(state) =>
        cn(toggleVariants({ variant: props.variant, size: props.size }), stateClass(props.class, state))
      }
      {...rest}
    />
  );
}
