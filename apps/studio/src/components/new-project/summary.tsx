import type { JSX } from "@solidjs/web";

/** One line of the Finish stage's summary. */
export function SummaryRow(props: { label: string; children: JSX.Element; testid: string }) {
  return (
    <li class="flex items-baseline gap-3 py-2 text-[11.5px]" data-testid={props.testid}>
      <span class="w-16 shrink-0 text-[10.5px] text-popover-muted">{props.label}</span>
      <span class="min-w-0 flex-1 text-popover-foreground">{props.children}</span>
    </li>
  );
}
