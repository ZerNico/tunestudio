import { Switch as SwitchPrimitive } from "base-ui-solid/switch";
import { omit } from "solid-js";

import { cn, stateClass } from "~/lib/utils";

/** shadcn/ui Switch (Base UI variant) on base-ui-solid. */
export function Switch(props: SwitchPrimitive.Root.Props & { size?: "sm" | "default" }) {
  const rest = omit(props, "class", "size");
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={props.size ?? "default"}
      class={(state) =>
        cn(
          "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 data-[size=default]:h-[18px] data-[size=default]:w-8 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-checked:bg-primary data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-50",
          stateClass(props.class, state),
        )
      }
      {...rest}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        class="pointer-events-none block rounded-full ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 data-checked:translate-x-[calc(100%-2px)] data-checked:bg-primary-foreground data-unchecked:translate-x-0 data-unchecked:bg-foreground"
      />
    </SwitchPrimitive.Root>
  );
}
