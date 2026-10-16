import type { JSX } from "@solidjs/web";
import { Menu as MenuPrimitive } from "base-ui-solid/menu";
import { omit } from "solid-js";
import CheckIcon from "~icons/lucide/check";
import ChevronRightIcon from "~icons/lucide/chevron-right";

import { cn, stateClass } from "~/lib/utils";

import {
  menuCheckItemClass,
  menuItemClass,
  menuLabelClass,
  menuPopupClass,
  menuSeparatorClass,
  menuShortcutClass,
} from "./menu-classes";

/** shadcn/ui DropdownMenu (Base UI variant, on Menu) on base-ui-solid. */
export function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}
export function DropdownMenuPortal(props: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}
export function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

export type DropdownMenuContentProps = MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">;

export function DropdownMenuContent(props: DropdownMenuContentProps) {
  const rest = omit(props, "class", "side", "sideOffset", "align", "alignOffset");
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        class="isolate z-[110] outline-none"
        align={props.align ?? "start"}
        alignOffset={props.alignOffset ?? 0}
        side={props.side ?? "bottom"}
        sideOffset={props.sideOffset ?? 4}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          class={(state) => cn(menuPopupClass, stateClass(props.class, state))}
          {...rest}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

export function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

export function DropdownMenuLabel(props: MenuPrimitive.GroupLabel.Props & { inset?: boolean }) {
  const rest = omit(props, "class", "inset");
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={props.inset ? "" : undefined}
      class={(state) => cn(menuLabelClass, stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function DropdownMenuItem(
  props: MenuPrimitive.Item.Props & { inset?: boolean; variant?: "default" | "destructive" },
) {
  const rest = omit(props, "class", "inset", "variant");
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={props.inset ? "" : undefined}
      data-variant={props.variant ?? "default"}
      class={(state) => cn(menuItemClass, stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function DropdownMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

export function DropdownMenuSubTrigger(props: MenuPrimitive.SubmenuTrigger.Props & { inset?: boolean }) {
  const rest = omit(props, "class", "inset", "children");
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={props.inset ? "" : undefined}
      class={(state) => cn(menuItemClass, "data-popup-open:bg-sage-23", stateClass(props.class, state))}
      {...rest}
    >
      {props.children}
      <ChevronRightIcon class="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

export function DropdownMenuSubContent(props: DropdownMenuContentProps) {
  return <DropdownMenuContent data-slot="dropdown-menu-sub-content" side="right" {...props} />;
}

export function DropdownMenuCheckboxItem(props: MenuPrimitive.CheckboxItem.Props & { inset?: boolean }) {
  const rest = omit(props, "class", "inset", "children");
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={props.inset ? "" : undefined}
      class={(state) => cn(menuCheckItemClass, stateClass(props.class, state))}
      {...rest}
    >
      <span class="pointer-events-none absolute right-2 flex items-center">
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {props.children}
    </MenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

export function DropdownMenuRadioItem(props: MenuPrimitive.RadioItem.Props & { inset?: boolean }) {
  const rest = omit(props, "class", "inset", "children");
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={props.inset ? "" : undefined}
      class={(state) => cn(menuCheckItemClass, stateClass(props.class, state))}
      {...rest}
    >
      <span class="pointer-events-none absolute right-2 flex items-center">
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {props.children}
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuSeparator(props: MenuPrimitive.Separator.Props) {
  const rest = omit(props, "class");
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      class={(state) => cn(menuSeparatorClass, stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function DropdownMenuShortcut(props: JSX.HTMLAttributes<HTMLSpanElement>) {
  const rest = omit(props, "class");
  return <span data-slot="dropdown-menu-shortcut" class={cn(menuShortcutClass, props.class as string)} {...rest} />;
}
