/**
 * The song's files in the song details: each with what it is, its name, size and (audio, video) length. The cover and
 * background always have a row: "Change…" (the cover in its own dialog, `song-artwork.tsx`; the background from an
 * image file), "Remove", or "Add…" when there is none. Changing them isn't part of undo.
 */
import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";
import FileAudioIcon from "~icons/lucide/file-audio";
import FileVideoIcon from "~icons/lucide/file-video";
import ImageIcon from "~icons/lucide/image";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { formatDuration, formatFileSize } from "~/lib/format";
import type { MediaRole, ProjectMedia } from "~/lib/native/types";

import type { ArtworkActions, ArtworkRole } from "./song-artwork";

const ROLE_LABELS: Record<MediaRole, string> = {
  audio: "Song",
  vocals: "Vocals",
  instrumental: "Music",
  video: "Video",
  cover: "Cover",
  background: "Background",
};

const ORDER: readonly MediaRole[] = ["audio", "vocals", "instrumental", "video", "cover", "background"];

/** How long an audio or video file plays, read from its metadata (without loading it all). */
function createMediaDuration(media: () => ProjectMedia | null) {
  const [duration, setDuration] = createSignal<number | null>(media()?.duration ?? null);
  onSettled(() => {
    const item = media();
    if (!item || item.duration !== null || !(item.mime.startsWith("audio/") || item.mime.startsWith("video/"))) return;
    const probe = document.createElement(item.mime.startsWith("video/") ? "video" : "audio");
    probe.preload = "metadata";
    probe.muted = true;
    const loaded = () => {
      if (Number.isFinite(probe.duration)) setDuration(probe.duration);
    };
    probe.addEventListener("loadedmetadata", loaded);
    probe.src = item.url;
    return () => {
      probe.removeEventListener("loadedmetadata", loaded);
      probe.removeAttribute("src");
      probe.load();
    };
  });
  return duration;
}

/** The file's picture (an image's own, small), or an icon for what it is. */
function Thumb(props: { media: ProjectMedia | null; role: MediaRole }) {
  return (
    <span class="flex size-7 items-center justify-center overflow-hidden rounded-[5px] bg-popover-well text-sage-63 [&>svg]:size-4">
      <Show
        when={props.media?.mime.startsWith("image/") ? props.media : null}
        fallback={props.role === "video" ? <FileVideoIcon /> : props.media ? <FileAudioIcon /> : <ImageIcon />}
      >
        {(image) => <img src={image().url} alt="" class="size-full object-cover" />}
      </Show>
    </span>
  );
}

function Row(props: { role: MediaRole; media: ProjectMedia | null; actions?: JSX.Element }) {
  const duration = createMediaDuration(() => props.media);
  return (
    <li
      class="grid grid-cols-[28px_76px_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-[11.5px]"
      data-testid={`file-${props.role}`}
    >
      <Thumb media={props.media} role={props.role} />
      <span class="text-muted-foreground">{ROLE_LABELS[props.role]}</span>
      <Show when={props.media} fallback={<span class="text-muted-foreground">None</span>}>
        {(media) => (
          <span class="flex min-w-0 items-baseline gap-3">
            <Tooltip>
              <TooltipTrigger
                render={(triggerProps: JSX.HTMLAttributes<HTMLSpanElement>) => (
                  <FileName {...triggerProps} name={media().fileName} />
                )}
              />
              <TooltipContent>{media().fileName}</TooltipContent>
            </Tooltip>
            <span class="shrink-0 font-mono text-[10.5px] text-muted-foreground tabular-nums">
              {formatFileSize(media().size)}
              {duration() === null ? "" : ` · ${formatDuration(duration()!)}`}
            </span>
          </span>
        )}
      </Show>
      <span class="flex justify-end gap-1">{props.actions}</span>
    </li>
  );
}

function FileName(props: JSX.HTMLAttributes<HTMLSpanElement> & { name: string }) {
  return (
    <span {...props} class="truncate font-mono text-[10.5px] text-foreground">
      {props.name}
    </span>
  );
}

export function SongFiles(props: {
  media: readonly ProjectMedia[];
  actions: ArtworkActions;
  /** Opens the cover's dialog. */
  onChangeCover: () => void;
}) {
  const [busy, setBusy] = createSignal<ArtworkRole | null>(null);
  const of = (role: MediaRole) => props.media.filter((item) => item.role === role);
  /** A new background from an image file, or no cover or background. */
  const run = async (role: ArtworkRole, what: "choose" | "remove") => {
    setBusy(role);
    try {
      if (what === "remove") await props.actions.set(role, { kind: "none" });
      else {
        const image = await props.actions.chooseImage();
        if (image) await props.actions.set(role, { kind: "file", path: image.path });
      }
    } catch (error) {
      props.actions.onError(`Couldn't change the ${role}`, error);
    } finally {
      setBusy(null);
    }
  };
  /** The cover has its own dialog; the background is an image file. */
  const change = (role: ArtworkRole) => {
    if (role === "cover") props.onChangeCover();
    else void run(role, "choose");
  };
  /** Change (or Add) and Remove, for the cover and background. */
  const artworkActions = (role: ArtworkRole, present: boolean) => (
    <Show
      when={busy() !== role}
      fallback={
        <output aria-label="Changing" class="flex">
          <LoaderCircleIcon class="m-1.5 size-4 animate-spin text-primary" aria-hidden="true" />
        </output>
      }
    >
      <Button variant="outline" size="xs" disabled={busy() !== null} onClick={() => change(role)}>
        {present ? "Change…" : "Add…"}
      </Button>
      <Show when={present}>
        <Button
          variant="ghost"
          size="xs"
          disabled={busy() !== null}
          onClick={() => void run(role, "remove")}
          data-testid={`remove-${role}`}
        >
          Remove
        </Button>
      </Show>
    </Show>
  );
  return (
    <div class="flex flex-col gap-2 border-t border-popover-line pt-4">
      <span class="eyebrow">Files</span>
      <ul
        aria-label="Files"
        class="m-0 flex list-none flex-col divide-y divide-border-soft overflow-hidden rounded-lg border border-border-soft p-0"
      >
        <For each={ORDER}>
          {(role) => {
            const artwork = role === "cover" || role === "background";
            return (
              <Show
                when={of(role).length > 0}
                fallback={
                  <Show when={artwork}>
                    <Row role={role} media={null} actions={artworkActions(role as ArtworkRole, false)} />
                  </Show>
                }
              >
                <For each={of(role)}>
                  {(media) => (
                    <Row
                      role={role}
                      media={media}
                      actions={artwork ? artworkActions(role as ArtworkRole, true) : undefined}
                    />
                  )}
                </For>
              </Show>
            );
          }}
        </For>
      </ul>
    </div>
  );
}
