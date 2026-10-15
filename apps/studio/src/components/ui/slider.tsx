import { Slider as SliderPrimitive } from "base-ui-solid/slider";
import { For, omit } from "solid-js";

import { cn, stateClass } from "~/lib/utils";

export type SliderProps = SliderPrimitive.Root.Props & {
  /** Accessible names for the thumbs' range inputs. */
  getAriaLabel?: (index: number) => string;
};

/** shadcn/ui Slider (Base UI variant) on base-ui-solid: 3px track, lime range, light thumb. */
export function Slider(props: SliderProps) {
  const rest = omit(props, "class", "getAriaLabel", "min", "max");
  const values = () => {
    const value = props.value ?? props.defaultValue;
    return Array.isArray(value) ? value : value === undefined ? [props.min ?? 0, props.max ?? 100] : [value];
  };
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      min={props.min ?? 0}
      max={props.max ?? 100}
      thumbAlignment="edge"
      class={(state) => cn("data-horizontal:w-full data-vertical:h-full", stateClass(props.class, state))}
      {...rest}
    >
      <SliderPrimitive.Control class="relative flex w-full touch-none items-center py-1.5 select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          class="relative grow overflow-hidden rounded-full bg-slate-27 select-none data-horizontal:h-[3px] data-horizontal:w-full data-vertical:h-full data-vertical:w-[3px]"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            class="bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        <For each={values()}>
          {(_, index) => (
            <SliderPrimitive.Thumb
              data-slot="slider-thumb"
              index={index()}
              getAriaLabel={props.getAriaLabel ?? null}
              class="relative block size-3 shrink-0 rounded-full border border-lime-89 bg-primary ring-primary/30 transition-[color,box-shadow] select-none after:absolute after:-inset-2 hover:ring-3 active:ring-3 disabled:pointer-events-none disabled:opacity-50 has-focus-visible:ring-3"
            />
          )}
        </For>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
