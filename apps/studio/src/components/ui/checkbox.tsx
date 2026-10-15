import { Checkbox as CheckboxPrimitive } from "base-ui-solid/checkbox";
import { omit } from "solid-js";
import CheckIcon from "~icons/lucide/check";

import { cn, stateClass } from "~/lib/utils";

/** shadcn/ui Checkbox (Base UI variant) on base-ui-solid. */
export function Checkbox(props: CheckboxPrimitive.Root.Props) {
  const rest = omit(props, "class");
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      class={(state) =>
        cn(
          "peer relative flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border border-input bg-field transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2 disabled:cursor-not-allowed disabled:opacity-50 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground",
          stateClass(props.class, state),
        )
      }
      {...rest}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        class="grid place-content-center text-current transition-none [&>svg]:size-3"
      >
        <CheckIcon stroke-width={2.4} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
