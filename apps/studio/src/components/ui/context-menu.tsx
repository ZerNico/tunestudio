import type { JSX } from "@solidjs/web";
import { ContextMenu as ContextMenuPrimitive } from "base-ui-solid/context-menu";
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

/** shadcn/ui ContextMenu (Base UI variant) on base-ui-solid. */
export function ContextMenu(props: ContextMenuPrimitive.Root.Props) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}
export function ContextMenuPortal(props: ContextMenuPrimitive.Portal.Props) {
  return <ContextMenuPrimitive.Portal data-slot="context-menu-portal" {...props} />;
}
export function ContextMenuTrigger(props: ContextMenuPrimitive.Trigger.Props) {
  const rest = omit(props, "class");
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      class={(state) => cn("select-none", stateClass(props.class, state))}
      {...rest}
    />
  );
}

export type ContextMenuContentProps = ContextMenuPrimitive.Popup.Props &
  Pick<ContextMenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">;

export function ContextMenuContent(props: ContextMenuContentProps) {
  const rest = omit(props, "class", "side", "sideOffset", "align", "alignOffset");
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        class="isolate z-[110] outline-none"
        align={props.align ?? "start"}
        alignOffset={props.alignOffset ?? 4}
        side={props.side ?? "right"}
        sideOffset={props.sideOffset ?? 0}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          class={(state) => cn(menuPopupClass, stateClass(props.class, state))}
          {...rest}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuGroup(props: ContextMenuPrimitive.Group.Props) {
  return <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />;
}

export function ContextMenuLabel(props: ContextMenuPrimitive.GroupLabel.Props & { inset?: boolean }) {
  const rest = omit(props, "class", "inset");
  return (
    <ContextMenuPrimitive.GroupLabel
      data-slot="context-menu-label"
      data-inset={props.inset ? "" : undefined}
      class={(state) => cn(menuLabelClass, stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function ContextMenuItem(
  props: ContextMenuPrimitive.Item.Props & { inset?: boolean; variant?: "default" | "destructive" },
) {
  const rest = omit(props, "class", "inset", "variant");
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={props.inset ? "" : undefined}
      data-variant={props.variant ?? "default"}
      class={(state) => cn(menuItemClass, stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function ContextMenuSub(props: ContextMenuPrimitive.SubmenuRoot.Props) {
  return <ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />;
}

export function ContextMenuSubTrigger(props: ContextMenuPrimitive.SubmenuTrigger.Props & { inset?: boolean }) {
  const rest = omit(props, "class", "inset", "children");
  return (
    <ContextMenuPrimitive.SubmenuTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={props.inset ? "" : undefined}
      class={(state) => cn(menuItemClass, "data-popup-open:bg-sage-23", stateClass(props.class, state))}
      {...rest}
    >
      {props.children}
      <ChevronRightIcon class="ml-auto" />
    </ContextMenuPrimitive.SubmenuTrigger>
  );
}

export function ContextMenuSubContent(props: ContextMenuContentProps) {
  return <ContextMenuContent data-slot="context-menu-sub-content" side="right" {...props} />;
}

export function ContextMenuCheckboxItem(props: ContextMenuPrimitive.CheckboxItem.Props & { inset?: boolean }) {
  const rest = omit(props, "class", "inset", "children");
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      data-inset={props.inset ? "" : undefined}
      class={(state) => cn(menuCheckItemClass, stateClass(props.class, state))}
      {...rest}
    >
      <span class="pointer-events-none absolute right-2 flex items-center">
        <ContextMenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </ContextMenuPrimitive.CheckboxItemIndicator>
      </span>
      {props.children}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

export function ContextMenuRadioGroup(props: ContextMenuPrimitive.RadioGroup.Props) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />;
}

export function ContextMenuRadioItem(props: ContextMenuPrimitive.RadioItem.Props & { inset?: boolean }) {
  const rest = omit(props, "class", "inset", "children");
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      data-inset={props.inset ? "" : undefined}
      class={(state) => cn(menuCheckItemClass, stateClass(props.class, state))}
      {...rest}
    >
      <span class="pointer-events-none absolute right-2 flex items-center">
        <ContextMenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </ContextMenuPrimitive.RadioItemIndicator>
      </span>
      {props.children}
    </ContextMenuPrimitive.RadioItem>
  );
}

export function ContextMenuSeparator(props: ContextMenuPrimitive.Separator.Props) {
  const rest = omit(props, "class");
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      class={(state) => cn(menuSeparatorClass, stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function ContextMenuShortcut(props: JSX.HTMLAttributes<HTMLSpanElement>) {
  const rest = omit(props, "class");
  return <span data-slot="context-menu-shortcut" class={cn(menuShortcutClass, props.class as string)} {...rest} />;
}
