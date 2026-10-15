import { Collapsible as CollapsiblePrimitive } from "base-ui-solid/collapsible";

/** shadcn/ui Collapsible (Base UI variant) on base-ui-solid. */
export function Collapsible(props: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}
export function CollapsibleTrigger(props: CollapsiblePrimitive.Trigger.Props) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}
export function CollapsibleContent(props: CollapsiblePrimitive.Panel.Props) {
  return <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />;
}
