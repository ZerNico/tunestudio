/**
 * The song's times in the song details: where the game starts and stops playing, where the song list's preview plays
 * from, the medley, and the video's offset. The first four are also markers on the timeline (`song-markers.ts`); here
 * they are set to the playhead (the medley to the selected notes' lines), played from, or cleared.
 */
import { Show } from "solid-js";
import CrosshairIcon from "~icons/lucide/crosshair";
import PlayIcon from "~icons/lucide/play";
import XIcon from "~icons/lucide/x";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import type { SongMarker } from "~/lib/editor/song-markers";
import { formatTime } from "~/lib/editor/view";
import type { EditorSong } from "~/lib/native/types";

export interface TimingActions {
  set: (marker: SongMarker, seconds: number) => void;
  /** The medley over the selected notes' lines; false when no notes are selected. */
  setMedleyFromSelection: () => boolean;
  clear: (marker: SongMarker) => void;
  playFrom: (seconds: number) => void;
  setVideoGap: (seconds: number | null) => void;
}

function Row(props: {
  label: string;
  hint: string;
  value: string | null;
  /** What it is when not set. */
  unset: string;
  playFrom: number | null;
  setLabel: string;
  canSet?: boolean;
  onSet: () => void;
  onClear: () => void;
  onPlay: (seconds: number) => void;
  testid: string;
}) {
  return (
    <div class="grid grid-cols-[110px_minmax(0,1fr)_auto] items-center gap-3" data-testid={props.testid}>
      <span class="text-[11px] text-sage-68" title={props.hint}>
        {props.label}
      </span>
      <span class="truncate font-mono text-[11px] text-foreground" data-testid="timing-value">
        {props.value ?? <span class="font-sans text-muted-foreground">{props.unset}</span>}
      </span>
      <div class="flex gap-1">
        <Button variant="outline" size="sm" disabled={props.canSet === false} onClick={() => props.onSet()}>
          <CrosshairIcon />
          {props.setLabel}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Play from the ${props.label.toLowerCase()}`}
          disabled={props.playFrom === null}
          onClick={() => props.onPlay(props.playFrom!)}
        >
          <PlayIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Clear the ${props.label.toLowerCase()}`}
          disabled={props.value === null}
          onClick={() => props.onClear()}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
}

const time = (seconds: number | null) => (seconds === null ? null : formatTime(seconds));

export function SongTiming(props: {
  song: EditorSong;
  hasVideo: boolean;
  /** Whether notes are selected (the medley is set from their lines). */
  hasSelection: boolean;
  actions: TimingActions;
  playheadTime: () => number;
}) {
  const play = (seconds: number) => props.actions.playFrom(seconds);
  return (
    <div class="flex flex-col gap-2 border-t border-popover-line pt-4" data-testid="song-timing">
      <span class="eyebrow">Timing (also on the timeline)</span>
      <Row
        label="Start"
        hint="The game starts playing here, skipping what is before"
        value={time(props.song.start)}
        unset="The song's start"
        playFrom={props.song.start}
        setLabel="Playhead"
        onSet={() => props.actions.set("start", props.playheadTime())}
        onClear={() => props.actions.clear("start")}
        onPlay={play}
        testid="timing-start"
      />
      <Row
        label="End"
        hint="The game stops here"
        value={time(props.song.end)}
        unset="The song's end"
        playFrom={props.song.end === null ? null : Math.max(0, props.song.end - 5)}
        setLabel="Playhead"
        onSet={() => props.actions.set("end", props.playheadTime())}
        onClear={() => props.actions.clear("end")}
        onPlay={play}
        testid="timing-end"
      />
      <Row
        label="Preview"
        hint="The song list plays the song from here"
        value={time(props.song.previewStart)}
        unset="Not set"
        playFrom={props.song.previewStart}
        setLabel="Playhead"
        onSet={() => props.actions.set("preview", props.playheadTime())}
        onClear={() => props.actions.clear("preview")}
        onPlay={play}
        testid="timing-preview"
      />
      <Row
        label="Medley"
        hint="The excerpt sung in medley mode: whole lines"
        value={
          props.song.medleyStart === null || props.song.medleyEnd === null
            ? null
            : `${formatTime(props.song.medleyStart)} – ${formatTime(props.song.medleyEnd)}`
        }
        unset="Not set"
        playFrom={props.song.medleyStart}
        setLabel="Selected lines"
        canSet={props.hasSelection}
        onSet={() => props.actions.setMedleyFromSelection()}
        onClear={() => props.actions.clear("medleyStart")}
        onPlay={play}
        testid="timing-medley"
      />
      <Show when={props.hasVideo}>
        <Label class="mt-1" title="How much later the video starts than the song (negative: earlier)">
          Video offset (s)
          <Input
            class="w-[120px]"
            value={props.song.videoGap === null ? "" : String(props.song.videoGap)}
            placeholder="0"
            inputmode="decimal"
            onChange={(event) => {
              const input = event.currentTarget;
              const text = input.value.trim().replace(",", ".");
              const seconds = text === "" ? null : Number(text);
              if (seconds !== null && !Number.isFinite(seconds)) {
                input.value = props.song.videoGap === null ? "" : String(props.song.videoGap);
                return;
              }
              props.actions.setVideoGap(seconds);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            data-testid="video-gap"
          />
        </Label>
      </Show>
    </div>
  );
}
