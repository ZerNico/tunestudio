import { Toggle as TogglePrimitive } from "base-ui-solid/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "base-ui-solid/toggle-group";
import type { VariantProps } from "class-variance-authority";
import { createContext, omit, useContext } from "solid-js";

import { cn, stateClass } from "~/lib/utils";

import { toggleVariants } from "./toggle";

type GroupContext = VariantProps<typeof toggleVariants> & { spacing?: number; orientation?: "horizontal" | "vertical" };
const ToggleGroupContext = createContext<GroupContext>({
  size: "default",
  variant: "default",
  spacing: 2,
  orientation: "horizontal",
});

export type ToggleGroupProps = ToggleGroupPrimitive.Props &
  VariantProps<typeof toggleVariants> & { spacing?: number; orientation?: "horizontal" | "vertical" };

/** shadcn/ui ToggleGroup (Base UI variant) on base-ui-solid. The `segment` variant is a segmented control in a field well. */
export function ToggleGroup(props: ToggleGroupProps) {
  const rest = omit(props, "class", "variant", "size", "spacing", "orientation", "children", "style");
  const context: GroupContext = {
    get variant() {
      return props.variant;
    },
    get size() {
      return props.size;
    },
    get spacing() {
      return props.spacing ?? 2;
    },
    get orientation() {
      return props.orientation ?? "horizontal";
    },
  };
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={props.variant}
      data-size={props.size}
      data-spacing={props.spacing ?? 2}
      orientation={props.orientation ?? "horizontal"}
      style={{ "--gap": String(props.spacing ?? 2) }}
      class={(state) =>
        cn(
          "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] rounded-lg data-[variant=segment]:border data-[variant=segment]:border-popover-line data-[variant=segment]:bg-field data-[variant=segment]:p-0.5 data-vertical:flex-col data-vertical:items-stretch",
          stateClass(props.class, state),
        )
      }
      {...rest}
    >
      <ToggleGroupContext value={context}>{props.children}</ToggleGroupContext>
    </ToggleGroupPrimitive>
  );
}

export type ToggleGroupItemProps = TogglePrimitive.Props & VariantProps<typeof toggleVariants>;

export function ToggleGroupItem(props: ToggleGroupItemProps) {
  const context = useContext(ToggleGroupContext);
  const rest = omit(props, "class", "variant", "size");
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={context.variant || props.variant}
      data-size={context.size || props.size}
      data-spacing={context.spacing}
      class={(state) =>
        cn(
          "shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-2 focus:z-10 focus-visible:z-10 group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-lg group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-lg",
          toggleVariants({ variant: context.variant || props.variant, size: context.size || props.size }),
          stateClass(props.class, state),
        )
      }
      {...rest}
    />
  );
}
