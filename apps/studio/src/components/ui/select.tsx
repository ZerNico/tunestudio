import { Select as SelectPrimitive } from "base-ui-solid/select";
import { cva, type VariantProps } from "class-variance-authority";
import { omit } from "solid-js";
import CheckIcon from "~icons/lucide/check";
import ChevronDownIcon from "~icons/lucide/chevron-down";
import ChevronUpIcon from "~icons/lucide/chevron-up";

import { cn, stateClass } from "~/lib/utils";

import { menuLabelClass, menuPopupClass, menuSeparatorClass } from "./menu-classes";

/**
 * shadcn/ui Select (Base UI variant) on base-ui-solid. The trigger gains studio variants:
 * `default` is a bordered field (inspector), `ghost` a filled borderless chip (tool bars).
 */
export const Select = SelectPrimitive.Root;

export function SelectGroup(props: SelectPrimitive.Group.Props) {
  const rest = omit(props, "class");
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      class={(state) => cn("scroll-my-1 p-1", stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function SelectValue(props: SelectPrimitive.Value.Props) {
  const rest = omit(props, "class");
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      class={(state) => cn("flex flex-1 truncate text-left", stateClass(props.class, state))}
      {...rest}
    />
  );
}

export const selectTriggerVariants = cva(
  "flex w-fit items-center justify-between gap-1 rounded-lg border whitespace-nowrap text-foreground transition-colors outline-none select-none disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: "border-input bg-field hover:border-slate-36 data-popup-open:border-lime-59",
        ghost: "border-transparent bg-muted hover:border-sage-28-2 data-popup-open:border-slate-36",
      },
      size: {
        default: "h-7 pr-1.5 pl-2 text-[11px]",
        sm: "h-[26px] pr-1 pl-[7px] text-[11px]",
        xs: "h-[22px] rounded-[5px] pr-1 pl-1.5 text-[9px] [&_svg:not([class*='size-'])]:size-3",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type SelectTriggerProps = SelectPrimitive.Trigger.Props & VariantProps<typeof selectTriggerVariants>;

export function SelectTrigger(props: SelectTriggerProps) {
  const rest = omit(props, "class", "children", "variant", "size");
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={props.size ?? "default"}
      class={(state) =>
        cn(selectTriggerVariants({ variant: props.variant, size: props.size }), stateClass(props.class, state))
      }
      {...rest}
    >
      {props.children}
      <SelectPrimitive.Icon class="flex text-muted-foreground">
        <ChevronDownIcon class="pointer-events-none" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export type SelectContentProps = SelectPrimitive.Popup.Props &
  Pick<SelectPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger">;

export function SelectContent(props: SelectContentProps) {
  const rest = omit(props, "class", "children", "side", "sideOffset", "align", "alignOffset", "alignItemWithTrigger");
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={props.side ?? "bottom"}
        sideOffset={props.sideOffset ?? 4}
        align={props.align ?? "center"}
        alignOffset={props.alignOffset ?? 0}
        alignItemWithTrigger={props.alignItemWithTrigger ?? true}
        class="isolate z-[110]"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={String(props.alignItemWithTrigger ?? true)}
          class={(state) =>
            cn(
              menuPopupClass,
              "relative isolate w-(--anchor-width) min-w-24 p-0 data-[align-trigger=true]:animate-none",
              stateClass(props.class, state),
            )
          }
          {...rest}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List class="p-1">{props.children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel(props: SelectPrimitive.GroupLabel.Props) {
  const rest = omit(props, "class");
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      class={(state) => cn(menuLabelClass, stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function SelectItem(props: SelectPrimitive.Item.Props) {
  const rest = omit(props, "class", "children");
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      class={(state) =>
        cn(
          "relative flex w-full cursor-default items-center gap-2 rounded-md py-[5px] pr-7 pl-2 text-[11px] outline-hidden select-none data-highlighted:bg-sage-23 data-highlighted:text-white data-selected:text-primary-text data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
          stateClass(props.class, state),
        )
      }
      {...rest}
    >
      <SelectPrimitive.ItemText class="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
        {props.children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={(p) => (
          <span
            {...p}
            class="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center text-primary"
          />
        )}
      >
        <CheckIcon />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator(props: SelectPrimitive.Separator.Props) {
  const rest = omit(props, "class");
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      class={(state) => cn("pointer-events-none", menuSeparatorClass, stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function SelectScrollUpButton(props: SelectPrimitive.ScrollUpArrow.Props) {
  const rest = omit(props, "class");
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      class={(state) =>
        cn(
          "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1",
          stateClass(props.class, state),
        )
      }
      {...rest}
    >
      <ChevronUpIcon class="size-3.5" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

export function SelectScrollDownButton(props: SelectPrimitive.ScrollDownArrow.Props) {
  const rest = omit(props, "class");
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      class={(state) =>
        cn(
          "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1",
          stateClass(props.class, state),
        )
      }
      {...rest}
    >
      <ChevronDownIcon class="size-3.5" />
    </SelectPrimitive.ScrollDownArrow>
  );
}
