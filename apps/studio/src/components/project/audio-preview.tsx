import { createSignal, onSettled } from "solid-js";
import PauseIcon from "~icons/lucide/pause";
import PlayIcon from "~icons/lucide/play";

import { Button } from "~/components/ui/button";
import { Slider } from "~/components/ui/slider";
import { formatDuration } from "~/lib/format";

/** Plays a project's audio: play/pause, position and seeking. */
export function AudioPreview(props: { src: string; label: string }) {
  const [playing, setPlaying] = createSignal(false);
  const [time, setTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  let audio: HTMLAudioElement | undefined;

  onSettled(() => {
    const element = audio;
    return () => element?.pause();
  });

  const toggle = () => {
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setPlaying(false));
    else audio.pause();
  };

  return (
    <div
      class="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
      data-testid="audio-preview"
    >
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption -- a song preview has nothing to caption */}
      <audio
        ref={(element) => (audio = element)}
        src={props.src}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <Button
        variant="secondary"
        size="icon"
        aria-label={playing() ? "Pause" : "Play"}
        onClick={toggle}
        data-testid="audio-play"
      >
        {playing() ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <span class="w-10 shrink-0 text-right font-mono text-[10.5px] text-muted-foreground tabular-nums">
        {formatDuration(time())}
      </span>
      <Slider
        class="flex-1"
        min={0}
        max={Math.max(duration(), 0.001)}
        step={0.01}
        value={time()}
        disabled={duration() === 0}
        getAriaLabel={() => `Position in ${props.label}`}
        onValueChange={(value: number | readonly number[]) => {
          const next = Array.isArray(value) ? value[0] : value;
          if (audio && typeof next === "number") {
            audio.currentTime = next;
            setTime(next);
          }
        }}
      />
      <span class="w-10 shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">
        {formatDuration(duration())}
      </span>
    </div>
  );
}
