import type { ErrorComponentProps } from "@tanstack/solid-router";
import TriangleAlertIcon from "~icons/lucide/triangle-alert";

import { Button } from "~/components/ui/button";

/** Shown when a route fails to load or render, instead of a blank window. */
export function RouteError(props: ErrorComponentProps) {
  return (
    <div class="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center app-drag" role="alert">
      <TriangleAlertIcon class="size-8 text-destructive" />
      <h1 class="m-0 text-[18px] font-semibold">Something went wrong</h1>
      <pre class="m-0 max-w-[640px] overflow-auto rounded-lg border border-border bg-card p-3 text-left font-mono text-[11px] whitespace-pre-wrap text-muted-foreground app-no-drag">
        {props.error instanceof Error ? props.error.message : String(props.error)}
      </pre>
      <div class="app-no-drag">
        <Button onClick={() => props.reset()}>Try again</Button>
      </div>
    </div>
  );
}
