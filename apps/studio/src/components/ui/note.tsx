import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import OctagonAlertIcon from "~icons/lucide/octagon-alert";
import TriangleAlertIcon from "~icons/lucide/triangle-alert";

/** A warning or error note inside the dialog. */
export function Note(props: { tone: "warning" | "error"; testid: string; children: JSX.Element }) {
  return (
    <div
      role={props.tone === "error" ? "alert" : "note"}
      data-tone={props.tone}
      data-testid={props.testid}
      class="flex gap-3 rounded-[9px] border px-3.5 py-3 text-[11px] leading-[1.6] data-[tone=error]:border-stone-39 data-[tone=error]:bg-stone-19 data-[tone=error]:text-stone-85 data-[tone=warning]:border-amber-33 data-[tone=warning]:bg-warning-soft data-[tone=warning]:text-amber-73"
    >
      <Show when={props.tone === "error"} fallback={<TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-warning" />}>
        <OctagonAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
      </Show>
      <div class="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}
