import { For } from "solid-js";

import { cn } from "~/lib/utils";

const BARS = [0.45, 1, 0.75, 0.38];

/**
 * The Tune Studio mark: four level bars, lime to emerald like the TunePerfect icon's green.
 * Sized by its `class` (`size-5` by default); purely decorative.
 */
export function BrandMark(props: { class?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" data-slot="brand-mark" class={cn("size-5", props.class)}>
      <defs>
        <linearGradient id="brand-mark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--lime-89)" />
          <stop offset="1" stop-color="var(--chart-2)" />
        </linearGradient>
      </defs>
      <For each={BARS}>
        {(height, index) => (
          <rect
            x={2.25 + index() * 4.25}
            y={10 - height * 8.5}
            width="2.75"
            height={height * 17}
            rx="1.375"
            fill="url(#brand-mark-fill)"
          />
        )}
      </For>
    </svg>
  );
}
