import type { JSX } from "@solidjs/web";
import { For, omit, Show } from "solid-js";
import ActivityIcon from "~icons/lucide/activity";
import LocateFixedIcon from "~icons/lucide/locate-fixed";
import MusicIcon from "~icons/lucide/music";
import PauseIcon from "~icons/lucide/pause";
import PlayIcon from "~icons/lucide/play";
import RepeatIcon from "~icons/lucide/repeat";
import Volume2Icon from "~icons/lucide/volume-2";
import VolumeXIcon from "~icons/lucide/volume-x";
import ZoomInIcon from "~icons/lucide/zoom-in";
import ZoomOutIcon from "~icons/lucide/zoom-out";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Slider } from "~/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { type Playback, SOURCE_LABELS, type Speed, SPEEDS } from "~/lib/editor/playback";

/** How loud the song (whichever source plays) and the tones are, 0-1. */
export interface Volumes {
  song: number;
  tones: number;
}
import { formatTime } from "~/lib/editor/view";

const speedLabel = (speed: number) => `${speed}×`;

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

/** A volume slider in the bar (its percentage in its tooltip). */
function InlineVolume(props: {
  label: string;
  value: number;
  /** Muted or off: drawn fainter. */
  dimmed?: boolean;
  onChange: (value: number) => void;
  testid: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(triggerProps: JSX.HTMLAttributes<HTMLDivElement>) => (
          <VolumeTrack {...triggerProps} dimmed={props.dimmed} data-testid={props.testid}>
            <Slider
              min={0}
              max={100}
              step={1}
              value={Math.round(props.value * 100)}
              getAriaLabel={() => props.label}
              onValueChange={(value: number | readonly number[]) =>
                props.onChange((typeof value === "number" ? value : (value[0] ?? 0)) / 100)
              }
            />
          </VolumeTrack>
        )}
      />
      <TooltipContent>
        {props.label} {Math.round(props.value * 100)}%
      </TooltipContent>
    </Tooltip>
  );
}

function VolumeTrack(props: JSX.HTMLAttributes<HTMLDivElement> & { dimmed?: boolean }) {
  const rest = omit(props, "dimmed");
  return (
    <div
      {...rest}
      class="mr-1 flex w-16 items-center transition-opacity data-dimmed:opacity-45"
      data-dimmed={props.dimmed ? "" : undefined}
    />
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
  volumes: Volumes;
  onVolume: (channel: keyof Volumes, volume: number) => void;
}) {
  /** The song's volume before muting, to go back to. */
  let beforeMute = 1;
  /** The tones' volume before they were slid to nothing, to go back to when they are turned on. */
  let tonesBefore = 1;
  /** The tones' slider: at nothing they are off, like a muted song; moved up from off, they are on. */
  const changeTones = (value: number) => {
    if (value === 0) {
      if (props.volumes.tones > 0) tonesBefore = props.volumes.tones;
      props.onTones(false);
    } else if (!props.tones) props.onTones(true);
    props.onVolume("tones", value);
  };
  const toggleTones = () => {
    if (props.tones) {
      props.onTones(false);
      return;
    }
    props.onTones(true);
    if (props.volumes.tones === 0) props.onVolume("tones", tonesBefore || 1);
  };
  const toggleMute = () => {
    if (props.volumes.song > 0) {
      beforeMute = props.volumes.song;
      props.onVolume("song", 0);
    } else props.onVolume("song", beforeMute || 1);
  };
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
      <div class="h-4 w-px bg-bar-border" aria-hidden="true" />
      <div class="flex items-center gap-1">
        <Show when={props.playback.available.length > 1}>
          <ToggleGroup
            variant="segment"
            size="segment"
            spacing={0.5}
            aria-label="Listen to"
            class="mr-1"
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
        <ToggleButton label="Loop" shortcut="L" pressed={props.looping} onClick={() => props.onLoop()} testid="loop">
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
            class="w-[62px]"
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
          label={props.volumes.song === 0 ? "Unmute" : "Mute"}
          pressed={false}
          onClick={toggleMute}
          testid="mute"
        >
          <Show when={props.volumes.song === 0} fallback={<Volume2Icon />}>
            <VolumeXIcon />
          </Show>
        </ToggleButton>
        <InlineVolume
          label="Song volume"
          value={props.volumes.song}
          dimmed={props.volumes.song === 0}
          onChange={(value) => props.onVolume("song", value)}
          testid="volume-song"
        />
        <ToggleButton
          label={props.tones ? "Tones: on (click to turn off)" : "Tones: off (click to turn on)"}
          pressed={false}
          onClick={toggleTones}
          testid="tones"
        >
          <span class="relative flex">
            <MusicIcon />
            {/* Off: struck through, like a muted speaker. */}
            <Show when={!props.tones}>
              <span class="absolute top-1/2 left-1/2 h-[1.5px] w-[20px] -translate-1/2 -rotate-45 rounded-full bg-current" />
            </Show>
          </span>
        </ToggleButton>
        <InlineVolume
          label="Tones volume"
          value={props.volumes.tones}
          dimmed={!props.tones}
          onChange={changeTones}
          testid="volume-tones"
        />
      </div>
      <div class="ml-auto flex items-center gap-1">
        <Show when={props.showPitch !== undefined}>
          <ToggleButton
            label="Sung pitch"
            pressed={props.showPitch === true}
            onClick={() => props.onShowPitch(!props.showPitch)}
            testid="show-pitch"
          >
            <ActivityIcon />
          </ToggleButton>
        </Show>
        <ToggleButton
          label="Follow playhead"
          pressed={props.following}
          onClick={() => props.onFollow(!props.following)}
          testid="follow"
        >
          <LocateFixedIcon />
        </ToggleButton>
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
