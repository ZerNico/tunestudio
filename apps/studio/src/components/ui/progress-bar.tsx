import { cn } from "~/lib/utils";

/**
 * A thin progress bar (a download, a separation, a chart being made). Without a `value` it shows it's working but
 * can't say how far. Call sites only add layout (its width; full width by default).
 */
export function ProgressBar(props: { label: string; value: number | undefined; max?: number; class?: string }) {
  return (
    <progress
      aria-label={props.label}
      max={props.max ?? 100}
      value={props.value}
      class={cn(
        "h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-sage-22 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-150",
        props.class,
      )}
    />
  );
}
