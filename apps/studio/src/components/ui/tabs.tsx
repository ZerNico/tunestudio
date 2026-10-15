import { Tabs as TabsPrimitive } from "base-ui-solid/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { omit } from "solid-js";

import { cn, stateClass } from "~/lib/utils";

/** shadcn/ui Tabs (Base UI variant) on base-ui-solid. */
export function Tabs(props: TabsPrimitive.Root.Props) {
  const rest = omit(props, "class", "orientation");
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      orientation={props.orientation ?? "horizontal"}
      class={(state) => cn("group/tabs flex gap-2 data-horizontal:flex-col", stateClass(props.class, state))}
      {...rest}
    />
  );
}

export const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-[7px] p-0.5 text-muted-foreground group-data-horizontal/tabs:h-[30px] group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: { variant: { default: "border border-segment-border bg-segment", line: "gap-1 bg-transparent" } },
    defaultVariants: { variant: "default" },
  },
);

export function TabsList(props: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  const rest = omit(props, "class", "variant");
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={props.variant ?? "default"}
      class={(state) => cn(tabsListVariants({ variant: props.variant }), stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function TabsTrigger(props: TabsPrimitive.Tab.Props) {
  const rest = omit(props, "class");
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      class={(state) =>
        cn(
          "relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-[5px] border border-transparent px-[9px] text-[11px] whitespace-nowrap text-sage-63 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
          "group-data-[variant=default]/tabs-list:data-active:bg-sage-23-2 group-data-[variant=default]/tabs-list:data-active:text-primary-text group-data-[variant=default]/tabs-list:data-active:shadow-[inset_0_0_0_1px_#405040]",
          "after:absolute after:bg-primary after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-[variant=line]/tabs-list:data-active:text-foreground group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
          stateClass(props.class, state),
        )
      }
      {...rest}
    />
  );
}

export function TabsContent(props: TabsPrimitive.Panel.Props) {
  const rest = omit(props, "class");
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      class={(state) => cn("flex-1 outline-none", stateClass(props.class, state))}
      {...rest}
    />
  );
}
