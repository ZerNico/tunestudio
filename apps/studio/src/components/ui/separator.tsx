import { Separator as SeparatorPrimitive } from "base-ui-solid/separator";
import { omit } from "solid-js";

import { cn, stateClass } from "~/lib/utils";

/** shadcn/ui Separator (Base UI variant) on base-ui-solid. */
export function Separator(props: SeparatorPrimitive.Props) {
  const rest = omit(props, "class", "orientation");
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={props.orientation ?? "horizontal"}
      class={(state) =>
        cn(
          "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
          stateClass(props.class, state),
        )
      }
      {...rest}
    />
  );
}
