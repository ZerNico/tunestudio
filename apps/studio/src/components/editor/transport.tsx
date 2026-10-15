import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import ActivityIcon from "~icons/lucide/activity";
import LocateFixedIcon from "~icons/lucide/locate-fixed";
import MusicIcon from "~icons/lucide/music";
import PauseIcon from "~icons/lucide/pause";
import PlayIcon from "~icons/lucide/play";
import RepeatIcon from "~icons/lucide/repeat";
import ZoomInIcon from "~icons/lucide/zoom-in";
import ZoomOutIcon from "~icons/lucide/zoom-out";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { type Playback, SOURCE_LABELS, type Speed, SPEEDS } from "~/lib/editor/playback";
import { formatTime } from "~/lib/editor/view";

const speedLabel = (speed: number) => `${Math.round(speed * 100)}%`;

/** An on/off button with its name (and key) in a tooltip. */
function ToggleButton(props: {
  label: string;
  shortcut?: string;
  pressed: boolean;
  onClick: () => void;
  testid: string;
  children: JSX.Element;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
          <Button
            {...triggerProps}
            variant={props.pressed ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={props.label}
            aria-pressed={props.pressed ? "true" : "false"}
            onClick={() => props.onClick()}
            data-testid={props.testid}
          >
            {props.children}
          </Button>
        )}
      />
      <TooltipContent>
        {props.label}
        <Show when={props.shortcut}>
          {" "}
          <Kbd>{props.shortcut}</Kbd>
        </Show>
      </TooltipContent>
    </Tooltip>
  );
}

/** Play/pause, where the playhead is, which source plays, looping, speed, following, tones, and zoom. */
export function Transport(props: {
  playback: Playback;
  length: number;
  onZoom: (factor: number) => void;
  /** Whether the sung pitch is drawn; undefined when the project has none to draw. */
  showPitch?: boolean;
  onShowPitch: (show: boolean) => void;
  looping: boolean;
  onLoop: () => void;
  following: boolean;
  onFollow: (follow: boolean) => void;
  /** Whether notes are heard as tones (along with playback, and while their pitch is changed). */
  tones: boolean;
  onTones: (tones: boolean) => void;
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
        <ToggleButton
          label="Loop the range marked on the ruler"
          shortcut="L"
          pressed={props.looping}
          onClick={() => props.onLoop()}
          testid="loop"
        >
          <RepeatIcon />
        </ToggleButton>
        <Select
          items={SPEEDS.map((speed) => ({ value: speed, label: speedLabel(speed) }))}
          value={props.playback.speed()}
          onValueChange={(value: Speed | null) => {
            if (value !== null) props.playback.setSpeed(value);
          }}
        >
          <SelectTrigger
            variant="ghost"
            size="sm"
            class="w-[64px]"
            aria-label="Speed (the pitch stays)"
            data-testid="speed"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <For each={SPEEDS}>{(speed) => <SelectItem value={speed}>{speedLabel(speed)}</SelectItem>}</For>
          </SelectContent>
        </Select>
        <ToggleButton
          label="Follow the playhead while playing"
          pressed={props.following}
          onClick={() => props.onFollow(!props.following)}
          testid="follow"
        >
          <LocateFixedIcon />
        </ToggleButton>
        <ToggleButton
          label="Hear the notes as tones (while playing and changing their pitch)"
          pressed={props.tones}
          onClick={() => props.onTones(!props.tones)}
          testid="tones"
        >
          <MusicIcon />
        </ToggleButton>
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
