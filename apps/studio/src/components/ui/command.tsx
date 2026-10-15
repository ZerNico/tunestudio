import type { JSX } from "@solidjs/web";
import { Autocomplete as AutocompletePrimitive } from "base-ui-solid/autocomplete";
import { omit } from "solid-js";
import SearchIcon from "~icons/lucide/search";

import { cn, stateClass } from "~/lib/utils";

/**
 * shadcn/ui Command, rebuilt on base-ui-solid's Autocomplete (shadcn's version wraps cmdk, which
 * is React-only). The list is rendered inline and always open, so it behaves like a command
 * palette: the input is a combobox, the results are a listbox and the first match is highlighted.
 * Styling follows shadcn's command (rounded rows, muted shortcuts) in the studio palette.
 */
export type CommandProps<Item> = Omit<
  AutocompletePrimitive.Root.Props<Item>,
  "inline" | "open" | "items" | "filteredItems"
> & { items?: readonly Item[]; filteredItems?: readonly Item[] };

export function Command<Item>(props: CommandProps<Item>) {
  const rest = omit(props, "autoHighlight", "mode");
  return (
    <AutocompletePrimitive.Root
      data-slot="command"
      inline
      open
      autoHighlight={props.autoHighlight ?? "always"}
      mode={props.mode ?? "list"}
      {...rest}
    />
  );
}

export type CommandInputProps = AutocompletePrimitive.Input.Props & { trailing?: JSX.Element };

export function CommandInput(props: CommandInputProps) {
  const rest = omit(props, "class", "trailing");
  return (
    <div
      data-slot="command-input-wrapper"
      class="mx-5 my-[18px] flex items-center gap-3 rounded-[7px] border border-lime-48 bg-sage-9 px-[11px] py-2.5 shadow-[0_0_0_3px_#acc97907]"
    >
      <SearchIcon class="text-sage-71" />
      <AutocompletePrimitive.Input
        data-slot="command-input"
        class={(state) =>
          cn(
            "w-full flex-1 border-0 bg-transparent py-[3px] text-[12px] text-foreground outline-hidden placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
            stateClass(props.class, state),
          )
        }
        {...rest}
      />
      {props.trailing}
    </div>
  );
}

export function CommandList<Item>(props: AutocompletePrimitive.List.Props<Item>) {
  const rest = omit(props, "class");
  return (
    <AutocompletePrimitive.List
      data-slot="command-list"
      class={(state) =>
        cn(
          "max-h-[390px] scroll-py-1 scrollbar-thin overflow-x-hidden overflow-y-auto px-[9px] pb-2.5 outline-none",
          stateClass(props.class, state),
        )
      }
      {...rest}
    />
  );
}

export function CommandEmpty(props: AutocompletePrimitive.Empty.Props) {
  const rest = omit(props, "class");
  return (
    <AutocompletePrimitive.Empty
      data-slot="command-empty"
      class={(state) => cn("px-5 text-[12px] text-sage-69 not-empty:py-5 empty:p-0", stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function CommandGroup(props: AutocompletePrimitive.Group.Props) {
  const rest = omit(props, "class");
  return (
    <AutocompletePrimitive.Group
      data-slot="command-group"
      class={(state) => cn("overflow-hidden p-1 text-foreground", stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function CommandSeparator(props: AutocompletePrimitive.Separator.Props) {
  const rest = omit(props, "class");
  return (
    <AutocompletePrimitive.Separator
      data-slot="command-separator"
      class={(state) => cn("-mx-1 h-px bg-popover-line", stateClass(props.class, state))}
      {...rest}
    />
  );
}

export function CommandItem(props: AutocompletePrimitive.Item.Props) {
  const rest = omit(props, "class");
  return (
    <AutocompletePrimitive.Item
      data-slot="command-item"
      class={(state) =>
        cn(
          "group/command-item relative my-0.5 flex w-full cursor-default items-center gap-[13px] rounded-[7px] border border-transparent p-3 text-left outline-hidden select-none data-highlighted:border-lime-38 data-highlighted:bg-sage-23 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-lime-70",
          stateClass(props.class, state),
        )
      }
      {...rest}
    />
  );
}

export function CommandShortcut(props: JSX.HTMLAttributes<HTMLElement>) {
  const rest = omit(props, "class");
  return (
    <kbd
      data-slot="command-shortcut"
      class={cn(
        "ml-auto rounded-[4px] border border-gray-27 bg-gray-15 px-[5px] py-[2px] font-mono text-[10px] leading-[1.4] whitespace-nowrap text-subtle-foreground group-data-highlighted/command-item:text-primary-text empty:hidden",
        props.class as string,
      )}
      {...rest}
    />
  );
}
