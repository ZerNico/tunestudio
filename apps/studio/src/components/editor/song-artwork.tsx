/**
 * Changing the song's cover, in a dialog of its own (from "Change…" in the song's files): tiles like setup's cover
 * picker (`CoverOption`): the cover the song has now, covers found online (looked for when this opens), none, and
 * choosing an image file. Picking a tile changes it at once (not part of undo) and closes the dialog.
 */
import { createSignal, For, onSettled, Show } from "solid-js";
import BanIcon from "~icons/lucide/ban";
import ImagePlusIcon from "~icons/lucide/image-plus";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { CoverOption, describeCover, tileClass } from "~/components/new-project/cover-picker";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import type { ArtworkChoice } from "~/lib/native/contract";
import type { ChosenImage, CoverCandidate } from "~/lib/native/types";

export type ArtworkRole = "cover" | "background";

export interface ArtworkActions {
  /** Replaces (or removes) the cover or background; rejects with what went wrong. */
  set: (role: ArtworkRole, choice: ArtworkChoice) => Promise<void>;
  findCovers: () => Promise<readonly CoverCandidate[]>;
  chooseImage: () => Promise<ChosenImage | null>;
  /** Shows what went wrong. */
  onError: (title: string, error: unknown) => void;
}

const SOURCE_LABELS: Record<CoverCandidate["source"], string> = {
  itunes: "Apple Music",
  deezer: "Deezer",
  musicbrainz: "MusicBrainz",
};

/** The tiles; `onDone` once a choice is applied. */
function CoverTiles(props: { url: string | undefined; actions: ArtworkActions; onDone: () => void }) {
  const [busy, setBusy] = createSignal(false);
  /** Found covers: null while looking. */
  const [covers, setCovers] = createSignal<readonly CoverCandidate[] | null>(null);
  onSettled(() => {
    props.actions.findCovers().then(setCovers, (error: unknown) => {
      setCovers([]);
      props.actions.onError("Couldn't look for covers", error);
    });
  });
  const apply = async (choice: ArtworkChoice) => {
    setBusy(true);
    try {
      await props.actions.set("cover", choice);
      props.onDone();
    } catch (error) {
      props.actions.onError("Couldn't change the cover", error);
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    const image = await props.actions.chooseImage();
    if (image) await apply({ kind: "file", path: image.path });
  };
  return (
    <div
      role="radiogroup"
      aria-label="Cover"
      aria-busy={busy() ? "true" : "false"}
      class="grid grid-cols-[repeat(auto-fill,minmax(80px,1fr))] gap-2.5 p-0.5"
      data-testid="cover-tiles"
    >
      <Show when={props.url}>
        {(url) => (
          <CoverOption
            name="song-cover"
            label="The song's cover"
            hint="The song's cover now"
            checked
            disabled={busy()}
            testid="cover-current"
            onSelect={() => {}}
          >
            <img src={url()} alt="" class="size-full object-cover" />
          </CoverOption>
        )}
      </Show>
      <For each={covers() ?? []}>
        {(cover) => (
          <CoverOption
            name="song-cover"
            label={`${cover.artist}, ${cover.album ?? cover.title} (${SOURCE_LABELS[cover.source]})`}
            hint={describeCover(cover)}
            checked={false}
            disabled={busy()}
            testid="cover-option"
            onSelect={() => void apply({ kind: "found", url: cover.url })}
          >
            <img src={cover.preview} alt="" class="size-full object-cover" />
          </CoverOption>
        )}
      </For>
      <Show when={covers() === null}>
        <span class={`${tileClass} pointer-events-none`} data-testid="cover-loading">
          <LoaderCircleIcon class="size-4 animate-spin text-primary" aria-hidden="true" />
          <span class="sr-only">Looking for covers</span>
        </span>
      </Show>
      <CoverOption
        name="song-cover"
        label="No cover"
        hint="No cover"
        checked={!props.url}
        disabled={busy()}
        testid="cover-none"
        onSelect={() => void apply({ kind: "none" })}
      >
        <BanIcon class="size-5 text-popover-muted" />
      </CoverOption>
      <button
        type="button"
        disabled={busy()}
        class={`${tileClass} flex-col gap-1 border border-dashed border-popover-line bg-transparent text-[9.5px] text-popover-muted outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60`}
        aria-label="Choose an image…"
        onClick={() => void choose()}
        data-testid="cover-choose"
      >
        <ImagePlusIcon class="size-4" />
        Choose…
      </button>
    </div>
  );
}

export function CoverDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string | undefined;
  actions: ArtworkActions;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open: boolean) => props.onOpenChange(open)}>
      <DialogContent class="w-[min(520px,calc(100vw-32px))]" data-testid="cover-dialog">
        <DialogHeader>
          <DialogTitle>Change the cover</DialogTitle>
          <DialogDescription>Covers found for the song, an image of yours, or none.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {/* Only while open: the search runs when the dialog opens. */}
          <Show when={props.open}>
            <CoverTiles url={props.url} actions={props.actions} onDone={() => props.onOpenChange(false)} />
          </Show>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
