import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";

/** A part of the settings screen: its heading, what it is about, and its rows. */
export function Section(props: { id: string; title: string; description: string; children: JSX.Element }) {
  return (
    <section aria-labelledby={`${props.id}-title`} class="flex flex-col gap-4" data-testid={`settings-${props.id}`}>
      <div class="flex flex-col gap-1">
        <h2 id={`${props.id}-title`} class="m-0 text-[15px] font-semibold tracking-[-0.2px]">
          {props.title}
        </h2>
        <p class="m-0 text-[12px] leading-[1.6] text-muted-foreground">{props.description}</p>
      </div>
      {props.children}
    </section>
  );
}

/** A setting: its name and what it does on the left, the control on the right. */
export function Row(props: { id: string; label: string; description?: string; children: JSX.Element }) {
  return (
    <div class="flex items-center gap-6 px-4 py-3">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={props.id} class="text-[12.5px] font-medium text-foreground">
          {props.label}
        </span>
        <Show when={props.description}>
          <p class="m-0 text-[11px] leading-normal text-muted-foreground">{props.description}</p>
        </Show>
      </div>
      {props.children}
    </div>
  );
}
