/**
 * The song's video in the roll's top corner (under the ruler and the break lane), muted and kept with playback
 * (`video-sync.ts`), to check the video offset. It is dragged out of the way wherever it covers notes and resized from
 * its bottom-left corner, always inside the editor (`video-box.ts`), and closed with its x. Outside the video (before
 * its start with a negative offset, after its end) it is dark.
 */
import { createEffect, createSignal, onCleanup } from "solid-js";
import XIcon from "~icons/lucide/x";

import { Button } from "~/components/ui/button";
import { followDrag } from "~/lib/editor/drag";
import { clampBox, FIRST_BOX, movedBox, resizedBox, type VideoBox } from "~/lib/editor/video-box";
import { syncVideo } from "~/lib/editor/video-sync";

export function VideoPreview(props: {
  url: string;
  time: number;
  playing: boolean;
  speed: number;
  /** `#VIDEOGAP` (seconds; null: none). */
  offset: number | null;
  onClose: () => void;
}) {
  let video: HTMLVideoElement | undefined;
  let box: HTMLDivElement | undefined;
  const [shown, setShown] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [place, setPlace] = createSignal<VideoBox>(FIRST_BOX);
  createEffect(
    () => ({ time: props.time, playing: props.playing, speed: props.speed, offset: props.offset ?? 0, ready: ready() }),
    (state) => {
      if (video && state.ready) setShown(syncVideo(video, state));
    },
  );

  /** The editor area it sits in. */
  const area = () => {
    const parent = box?.offsetParent;
    return parent ? { width: parent.clientWidth, height: parent.clientHeight } : null;
  };
  // A smaller editor (a window made smaller, a lane shown) keeps it inside.
  const observer = new ResizeObserver(() => {
    const size = area();
    if (size) setPlace(clampBox(place(), size));
  });
  onCleanup(() => observer.disconnect());

  /** Follows a press: `change` gives the box for how far the pointer went. */
  const follow = (event: PointerEvent, change: (start: VideoBox, dx: number, dy: number) => VideoBox) => {
    const size = area();
    if (!size || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = place();
    followDrag({
      press: event,
      target: window,
      threshold: "xy",
      onMove: ({ dx, dy }) => setPlace(change(start, dx, dy)),
      onUp: () => {},
    });
  };

  return (
    <div
      ref={(element) => {
        box = element;
        queueMicrotask(() => box?.offsetParent && observer.observe(box.offsetParent));
      }}
      class="group absolute z-20 aspect-video cursor-move touch-none overflow-hidden rounded-xl border border-border bg-black shadow-lg select-none"
      style={{ top: `${place().top}px`, right: `${place().right}px`, width: `${place().width}px` }}
      title="Drag to move"
      onPointerDown={(event) => follow(event, (start, dx, dy) => movedBox(start, dx, dy, area()!))}
      data-testid="video-preview"
    >
      <video
        ref={(element) => (video = element)}
        src={props.url}
        muted
        playsinline
        preload="auto"
        class="pointer-events-none size-full object-contain data-hidden:invisible"
        data-hidden={shown() ? undefined : ""}
        onLoadStart={() => setReady(false)}
        onLoadedMetadata={() => setReady(true)}
        // A seek (scrubbing while paused) skipped the times that came meanwhile: catch up with the playhead.
        onSeeked={() => {
          if (video && ready())
            setShown(
              syncVideo(video, {
                time: props.time,
                playing: props.playing,
                speed: props.speed,
                offset: props.offset ?? 0,
              }),
            );
        }}
        aria-label="Video"
      />
      {/* Hovered, it darkens a little, so its controls stand out. */}
      <div class="pointer-events-none absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/35" />
      {/* Shown on hover (or when focused from the keyboard). */}
      <span class="absolute top-1.5 right-1.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100 has-focus-visible:opacity-100">
        <Button
          variant="overlay"
          size="icon-sm"
          aria-label="Close video"
          title="Close video"
          onPointerDown={(event: PointerEvent) => event.stopPropagation()}
          onClick={() => props.onClose()}
          data-testid="video-close"
        >
          <XIcon />
        </Button>
      </span>
      <div
        class="absolute bottom-0 left-0 size-6 cursor-nesw-resize text-white/80 opacity-0 transition-opacity duration-200 group-hover:opacity-100 hover:text-white"
        title="Drag to resize"
        onPointerDown={(event) => follow(event, (start, dx) => resizedBox(start, dx, area()!))}
        data-testid="video-resize"
      >
        {/* A curve along the rounded corner, as picture-in-picture windows show where they resize. */}
        <svg viewBox="0 0 24 24" class="size-full drop-shadow" aria-hidden="true">
          <path
            d="M5 9v3.5a6.5 6.5 0 0 0 6.5 6.5H15"
            fill="none"
            stroke="currentColor"
            stroke-width="2.25"
            stroke-linecap="round"
          />
        </svg>
      </div>
    </div>
  );
}
