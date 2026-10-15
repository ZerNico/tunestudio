import { For, Show } from "solid-js";
import ActivityIcon from "~icons/lucide/activity";
import PauseIcon from "~icons/lucide/pause";
import PlayIcon from "~icons/lucide/play";
import ZoomInIcon from "~icons/lucide/zoom-in";
import ZoomOutIcon from "~icons/lucide/zoom-out";

import { Button } from "~/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { type Playback, SOURCE_LABELS } from "~/lib/editor/playback";
import { formatTime } from "~/lib/editor/view";

/** Play/pause, where the playhead is, which source plays, and zoom. */
export function Transport(props: {
  playback: Playback;
  length: number;
  onZoom: (factor: number) => void;
  /** Whether the sung pitch is drawn; undefined when the project has none to draw. */
  showPitch?: boolean;
  onShowPitch: (show: boolean) => void;
}) {
  return (
    <footer
      class="flex h-11 shrink-0 items-center gap-3 border-t border-bar-border bg-transport px-3"
      data-testid="transport"
    >
      <Button
        size="icon-sm"
        aria-label={props.playback.playing() ? "Pause" : "Play"}
        disabled={!props.playback.source()}
        onClick={() => props.playback.toggle()}
        data-testid="transport-play"
      >
        <Show when={props.playback.playing()} fallback={<PlayIcon />}>
          <PauseIcon />
        </Show>
      </Button>
      <span class="font-mono text-[11px] text-foreground tabular-nums" data-testid="transport-time">
        {formatTime(props.playback.time())}
        <span class="text-faint-foreground"> / {formatTime(props.length, false)}</span>
      </span>
      <Show when={props.playback.available.length > 1}>
        <ToggleGroup
          variant="segment"
          size="segment"
          spacing={0.5}
          aria-label="Listen to"
          value={props.playback.source() ? [props.playback.source()!] : []}
          onValueChange={(value: unknown[]) => {
            const next = props.playback.available.find((source) => source === value[0]);
            if (next) props.playback.setSource(next);
          }}
        >
          <For each={props.playback.available}>
            {(source) => (
              <ToggleGroupItem value={source} data-testid={`source-${source}`}>
                {SOURCE_LABELS[source]}
              </ToggleGroupItem>
            )}
          </For>
        </ToggleGroup>
      </Show>
      <div class="ml-auto flex items-center gap-1">
        <Show when={props.showPitch !== undefined}>
          <Button
            variant={props.showPitch ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={props.showPitch ? "true" : "false"}
            title="What is sung, drawn behind the notes"
            onClick={() => props.onShowPitch(!props.showPitch)}
            data-testid="show-pitch"
          >
            <ActivityIcon />
            Pitch
          </Button>
        </Show>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => props.onZoom(1 / 1.5)}>
          <ZoomOutIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => props.onZoom(1.5)}>
          <ZoomInIcon />
        </Button>
      </div>
    </footer>
  );
}
