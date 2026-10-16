import type { JSX } from "@solidjs/web";
import { For, omit, Show } from "solid-js";
import BanIcon from "~icons/lucide/ban";
import ImagePlusIcon from "~icons/lucide/image-plus";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import type { ChosenImage, CoverCandidate } from "~/lib/native/types";

/** The project's cover: a found one, an image the user picked, the source's own picture, or none. */
export type CoverSelection =
  | { kind: "found"; url: string }
  | { kind: "file"; image: ChosenImage }
  | { kind: "thumbnail" }
  | { kind: "none" };

const SOURCE_LABELS: Record<CoverCandidate["source"], string> = {
  itunes: "Apple Music",
  deezer: "Deezer",
  musicbrainz: "MusicBrainz",
};

/** Where a found cover comes from, in a few words, e.g. "Single · 2022 · MusicBrainz". */
export function describeCover(cover: CoverCandidate): string {
  const release = cover.release === "single" ? "Single" : cover.album;
  return [release, cover.year, SOURCE_LABELS[cover.source]].filter(Boolean).join(" · ");
}

export const tileClass =
  "relative flex aspect-square w-full min-w-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-popover-well ring-offset-2 ring-offset-popover transition-shadow hover:ring-1 hover:ring-sage-38";
const optionClass = `${tileClass} has-checked:ring-2 has-checked:ring-primary has-focus-visible:ring-2 has-focus-visible:ring-ring has-disabled:pointer-events-none has-disabled:opacity-60`;

/** A choice's tile: a hidden native radio and its picture, ringed when the radio is checked. */
function OptionTile(
  props: JSX.LabelHTMLAttributes<HTMLLabelElement> & {
    name: string;
    label: string;
    checked: boolean;
    disabled?: boolean;
    onSelect: () => void;
  },
) {
  const rest = omit(props, "name", "label", "checked", "disabled", "onSelect", "children");
  return (
    <label {...rest} class={optionClass}>
      <input
        type="radio"
        name={props.name}
        class="sr-only"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.label}
        onChange={() => props.onSelect()}
      />
      {props.children}
    </label>
  );
}

/** One choice in the picker: a hidden native radio with its picture (its hint in a tooltip). */
export function CoverOption(props: {
  /** The radio group's name (one per picker). */
  name?: string;
  label: string;
  /** Shown on hover. */
  hint: string;
  checked: boolean;
  disabled?: boolean;
  testid: string;
  onSelect: () => void;
  children: JSX.Element;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(triggerProps: JSX.HTMLAttributes<HTMLLabelElement>) => (
          <OptionTile
            {...triggerProps}
            name={props.name ?? "cover"}
            label={props.label}
            checked={props.checked}
            disabled={props.disabled}
            onSelect={props.onSelect}
            data-testid={props.testid}
          >
            {props.children}
          </OptionTile>
        )}
      />
      <TooltipContent>{props.hint}</TooltipContent>
    </Tooltip>
  );
}

/** The source's own picture, as the cover picker offers it: the video's thumbnail or the file's artwork. */
export interface OwnPicture {
  label: string;
  hint: string;
  /** A preview, or null when it can't be shown. */
  image: string | null;
  /** Fills the tile without a preview. */
  placeholder: JSX.Element;
}

/**
 * Choosing the project's cover: album covers found for the song, best first, then the source's own picture (`own`;
 * none when it has none), an image the user picked, and no cover. `covers` is null while searching.
 */
export function CoverPicker(props: {
  covers: readonly CoverCandidate[] | null;
  own: OwnPicture | null;
  /** The image the user picked, offered as an option once there is one. */
  custom: ChosenImage | null;
  selected: CoverSelection;
  disabled?: boolean;
  onSelect: (selection: CoverSelection) => void;
  /** Opens the file dialog for an image. */
  onChooseFile: () => void;
}) {
  const selected = () => props.selected;
  return (
    <div class="flex flex-col gap-1.5" data-testid="cover-picker">
      <span id="cover-label" class="text-[10px] leading-none text-sage-68">
        Cover
      </span>
      {/* Square tiles that share the row, wrapping once they would get smaller than 72px. */}
      <div
        role="radiogroup"
        aria-labelledby="cover-label"
        class="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-2.5 p-0.5"
      >
        <For each={props.covers ?? []}>
          {(cover) => (
            <CoverOption
              label={`${cover.artist}, ${cover.album ?? cover.title} (${SOURCE_LABELS[cover.source]})`}
              hint={describeCover(cover)}
              checked={(() => {
                const current = selected();
                return current.kind === "found" && current.url === cover.url;
              })()}
              disabled={props.disabled}
              testid="cover-option"
              onSelect={() => props.onSelect({ kind: "found", url: cover.url })}
            >
              <img src={cover.preview} alt="" class="size-full object-cover" />
            </CoverOption>
          )}
        </For>
        {/* Searching: the found covers take this tile's place, in front of the others. */}
        <Show when={props.covers === null}>
          <span class={`${tileClass} pointer-events-none`} data-testid="cover-loading">
            <LoaderCircleIcon class="size-4 animate-spin text-primary" aria-hidden="true" />
            <span class="sr-only">Looking for covers</span>
          </span>
        </Show>
        <Show when={props.own}>
          {(own) => (
            <CoverOption
              label={own().label}
              hint={own().hint}
              checked={selected().kind === "thumbnail"}
              disabled={props.disabled}
              testid="cover-thumbnail"
              onSelect={() => props.onSelect({ kind: "thumbnail" })}
            >
              <Show when={own().image} fallback={own().placeholder}>
                {(image) => <img src={image()} alt="" class="size-full object-cover" />}
              </Show>
            </CoverOption>
          )}
        </Show>
        <Show when={props.custom}>
          {(image) => (
            <CoverOption
              label="Your image"
              hint={image().path.split(/[\\/]/).at(-1) ?? ""}
              checked={selected().kind === "file"}
              disabled={props.disabled}
              testid="cover-file"
              onSelect={() => props.onSelect({ kind: "file", image: image() })}
            >
              <img src={image().preview} alt="" class="size-full object-cover" />
            </CoverOption>
          )}
        </Show>
        <CoverOption
          label="No cover"
          hint="No cover"
          checked={selected().kind === "none"}
          disabled={props.disabled}
          testid="cover-none"
          onSelect={() => props.onSelect({ kind: "none" })}
        >
          <BanIcon class="size-5 text-popover-muted" />
        </CoverOption>
        <button
          type="button"
          disabled={props.disabled}
          class={`${tileClass} flex-col gap-1 border border-dashed border-popover-line bg-transparent text-[9.5px] text-popover-muted outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60`}
          aria-label="Choose an image…"
          onClick={() => props.onChooseFile()}
          data-testid="cover-choose"
        >
          <ImagePlusIcon class="size-4" />
          Choose…
        </button>
      </div>
    </div>
  );
}
