/**
 * The song's files in the song details: each with what it is, its name, size and (audio, video) length, and what can
 * be done with it. The song, vocals and music are replaced by a file of the user's (a new song asks whether to separate
 * the voice from it again); the video is replaced, added or removed; the cover and background are changed (the cover in
 * its own dialog, `song-artwork.tsx`; the background from an image file), added or removed. Under them, the voice can
 * be separated from the song again. None of this is part of undo.
 */
import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";
import FileAudioIcon from "~icons/lucide/file-audio";
import FileVideoIcon from "~icons/lucide/file-video";
import ImageIcon from "~icons/lucide/image";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { ProgressBar } from "~/components/ui/progress-bar";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { formatDuration, formatFileSize } from "~/lib/format";
import type { SongMediaRole } from "~/lib/native/contract";
import { percentOf } from "~/lib/native/progress";
import type { ImportProgress, MediaRole, ProjectMedia } from "~/lib/native/types";

import type { ArtworkActions, ArtworkRole } from "./song-artwork";

export interface MediaActions {
  /** An audio or video file of the user's, or null when they cancelled. */
  chooseFile: (kind: "audio" | "video") => Promise<string | null>;
  /** Puts the file in the role's place; rejects with what went wrong. */
  replace: (role: SongMediaRole, path: string) => Promise<void>;
  removeVideo: () => Promise<void>;
  /** Separating the voice from the song: its progress while it runs (null before the first), else undefined. */
  separating: () => ImportProgress | null | undefined;
  separate: () => void;
  stopSeparating: () => void;
  /** Shows what went wrong. */
  onError: (title: string, error: unknown) => void;
}

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
  songMedia: MediaActions;
  /** Opens the cover's dialog. */
  onChangeCover: () => void;
}) {
  const [busy, setBusy] = createSignal<MediaRole | null>(null);
  /** A new song is in: ask whether to separate the voice from it again. */
  const [asking, setAsking] = createSignal(false);
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
  /** A file of the user's in the song's, vocals', music's or video's place, or no video. */
  const runMedia = async (role: SongMediaRole, what: "choose" | "remove") => {
    setBusy(role);
    try {
      if (what === "remove") await props.songMedia.removeVideo();
      else {
        const path = await props.songMedia.chooseFile(role === "video" ? "video" : "audio");
        if (!path) return;
        await props.songMedia.replace(role, path);
        if (role === "audio") setAsking(true);
      }
    } catch (error) {
      props.songMedia.onError(`Couldn't change the ${ROLE_LABELS[role].toLowerCase()}`, error);
    } finally {
      setBusy(null);
    }
  };
  const spinner = (
    <output aria-label="Changing" class="flex">
      <LoaderCircleIcon class="m-1.5 size-4 animate-spin text-primary" aria-hidden="true" />
    </output>
  );
  /** Replace for the song, vocals and music; Replace (or Add) and Remove for the video. */
  const mediaActions = (role: SongMediaRole, present: boolean) => (
    <Show when={busy() !== role} fallback={spinner}>
      <Button
        variant="outline"
        size="xs"
        disabled={busy() !== null || props.songMedia.separating() !== undefined}
        onClick={() => void runMedia(role, "choose")}
        data-testid={`replace-${role}`}
      >
        {present ? "Replace" : "Add"}
      </Button>
      <Show when={role === "video" && present}>
        <Button
          variant="ghost"
          size="xs"
          disabled={busy() !== null}
          onClick={() => void runMedia(role, "remove")}
          data-testid="remove-video"
        >
          Remove
        </Button>
      </Show>
    </Show>
  );
  /** Change (or Add) and Remove, for the cover and background. */
  const artworkActions = (role: ArtworkRole, present: boolean) => (
    <Show when={busy() !== role} fallback={spinner}>
      <Button variant="outline" size="xs" disabled={busy() !== null} onClick={() => change(role)}>
        {present ? "Change" : "Add"}
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
            const actions = (present: boolean) =>
              artwork ? artworkActions(role as ArtworkRole, present) : mediaActions(role as SongMediaRole, present);
            return (
              <Show
                when={of(role).length > 0}
                fallback={
                  // The song, vocals and music are always there; the others have a row to add them.
                  <Show when={artwork || role === "video"}>
                    <Row role={role} media={null} actions={actions(false)} />
                  </Show>
                }
              >
                <For each={of(role)}>{(media) => <Row role={role} media={media} actions={actions(true)} />}</For>
              </Show>
            );
          }}
        </For>
      </ul>
      <Show
        when={props.songMedia.separating() !== undefined}
        fallback={
          <div class="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            The vocals and music are separated from the song.
            <Button
              variant="ghost"
              size="xs"
              disabled={busy() !== null}
              onClick={() => props.songMedia.separate()}
              data-testid="separate-again"
            >
              Separate again
            </Button>
          </div>
        }
      >
        <div class="flex items-center gap-3" data-testid="separating">
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <span class="text-[11px] text-popover-foreground" aria-live="polite">
              {props.songMedia.separating()?.step ?? "Separating the voice"}…
            </span>
            <ProgressBar label="Separating progress" value={percentOf(props.songMedia.separating() ?? null)} />
          </div>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => props.songMedia.stopSeparating()}
            data-testid="stop-separating"
          >
            Stop
          </Button>
        </div>
      </Show>
      <Dialog open={asking()} onOpenChange={(open: boolean) => setAsking(open)}>
        <DialogContent class="w-[min(440px,calc(100vw-32px))]" data-testid="separate-question">
          <DialogHeader>
            <DialogTitle>Separate the voice from the new song?</DialogTitle>
            <DialogDescription>The vocals and music are still from the old song.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={(closeProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
                <Button variant="outline" {...closeProps} />
              )}
              data-testid="keep-stems"
            >
              Keep them
            </DialogClose>
            <Button
              onClick={() => {
                setAsking(false);
                props.songMedia.separate();
              }}
              data-testid="separate-new-song"
            >
              Separate again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
