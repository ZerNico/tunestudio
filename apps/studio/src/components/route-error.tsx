import { type ErrorComponentProps, useRouter } from "@tanstack/solid-router";
import TriangleAlertIcon from "~icons/lucide/triangle-alert";

import { Button } from "~/components/ui/button";
import { errorMessage } from "~/lib/native/errors";

/**
 * Shown when a screen fails to load or render, instead of a blank window. Try again loads it again (a failed load
 * stays failed until then); Back to start leaves it. A screen's own error leaves the rest of the app (the rail) as it
 * is; the root's fills the window (`RootError`).
 */
export function RouteError(props: ErrorComponentProps) {
  const router = useRouter();
  const again = async () => {
    await router.invalidate();
    props.reset();
  };
  const home = async () => {
    await router.navigate({ to: "/" });
    props.reset();
  };
  return (
    <div
      class="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center app-drag"
      role="alert"
    >
      <TriangleAlertIcon class="size-8 text-destructive" />
      <h1 class="m-0 text-[18px] font-semibold">Something went wrong</h1>
      <pre class="m-0 max-w-[640px] overflow-auto rounded-lg border border-border bg-card p-3 text-left font-mono text-[11px] whitespace-pre-wrap text-muted-foreground app-no-drag">
        {errorMessage(props.error)}
      </pre>
      <div class="flex gap-2 app-no-drag">
        <Button onClick={() => void again()}>Try again</Button>
        <Button variant="outline" onClick={() => void home()}>
          Back to start
        </Button>
      </div>
    </div>
  );
}

/** The root's error: the whole window. */
export function RootError(props: ErrorComponentProps) {
  return (
    <div class="flex h-dvh">
      <RouteError {...props} />
    </div>
  );
}
