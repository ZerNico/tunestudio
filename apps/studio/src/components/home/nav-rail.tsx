import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import ClockIcon from "~icons/lucide/clock";
import HouseIcon from "~icons/lucide/house";
import SettingsIcon from "~icons/lucide/settings";

export type RailItem = "home" | "recent" | "settings";

type Item = { id: RailItem; label: string; icon: (props: JSX.SvgSVGAttributes<SVGSVGElement>) => JSX.Element };

const ITEMS: Item[] = [
  { id: "home", label: "Home", icon: HouseIcon },
  { id: "recent", label: "Recent", icon: ClockIcon },
];

/** Pinned to the bottom of the rail. */
const SETTINGS: Item = { id: "settings", label: "Settings", icon: SettingsIcon };

const itemClass =
  "relative flex w-[60px] flex-col items-center gap-1 rounded-lg py-2 text-[10px] font-medium text-sage-63 transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-primary-text [&>svg]:size-5 aria-[current=page]:before:absolute aria-[current=page]:before:top-2.5 aria-[current=page]:before:bottom-2.5 aria-[current=page]:before:-left-2 aria-[current=page]:before:w-[3px] aria-[current=page]:before:rounded-r-full aria-[current=page]:before:bg-primary";

/** Adobe-style left rail: Home and Recent (which scrolls to its list) on the start screen, and Settings. */
export function NavRail(props: { active: RailItem; onSelect: (item: RailItem) => void }) {
  const Item = (item: Item) => (
    <button
      type="button"
      class={itemClass}
      aria-current={props.active === item.id ? "page" : undefined}
      onClick={() => props.onSelect(item.id)}
      data-testid={`rail-${item.id}`}
    >
      <item.icon />
      {item.label}
    </button>
  );
  return (
    <nav
      aria-label="Main"
      class="flex w-(--rail-w) shrink-0 flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar py-3"
    >
      <For each={ITEMS}>{(item) => Item(item)}</For>
      <div class="mt-auto">{Item(SETTINGS)}</div>
    </nav>
  );
}
