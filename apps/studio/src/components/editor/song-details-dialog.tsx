/**
 * The song's details in a dialog (opened from the song's name in the title bar): what the song list shows and what is
 * exported in the chart's headers. Each field is saved when it is left or Enter is pressed, as an edit (undo takes it
 * back); a title or artist left empty, or a year that isn't one, goes back to what it was.
 */
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import ChevronRightIcon from "~icons/lucide/chevron-right";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { formatNumber, formatSeconds } from "~/lib/format";
import type { SongFields } from "~/lib/native/contract";
import type { EditorSong, LyricsLine } from "~/lib/native/types";

import { LyricsList } from "./song-lyrics";

export interface SongDetailsSinger {
  id: number;
  index: number;
  name: string | null;
}

/** A comma-separated list as its items (trimmed, no empty ones). */
export function listFrom(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A year as typed: null when empty, undefined when it isn't a year. */
export function yearFrom(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return /^\d{4}$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** Optional text as typed: null when empty. */
const optional = (text: string) => text.trim() || null;

/** A text field saved when it is left (or Enter is pressed); `save` returns false to put the old text back. */
function Field(props: {
  label: string;
  value: string;
  placeholder?: string;
  save: (text: string) => boolean | void;
  testid: string;
  inputmode?: "numeric" | "text";
}) {
  return (
    <Label layout="stacked">
      {props.label}
      <Input
        value={props.value}
        placeholder={props.placeholder}
        inputmode={props.inputmode}
        onChange={(event) => {
          const input = event.currentTarget;
          if (props.save(input.value) === false) input.value = props.value;
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        data-testid={props.testid}
      />
    </Label>
  );
}

export function SongDetailsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  song: EditorSong;
  /** The chart's grid (shown, not edited here). */
  bpm: number;
  gap: number;
  singers: readonly SongDetailsSinger[];
  /** Headers the song came with that Tune Studio doesn't edit (kept for export). */
  otherHeaders: readonly (readonly [string, string])[];
  /** Saves a change as an edit called `label`. */
  onChange: (label: string, patch: SongFields) => void;
  onSingerName: (id: number, name: string | null) => void;
  /** The song's files, with changing the cover and background (`song-files.tsx`). */
  files?: JSX.Element;
  /** Start, end, preview, medley and video offset (`song-timing.tsx`). */
  timing?: JSX.Element;
  /** Dialogs opened from this one (they dim it while open). */
  nested?: JSX.Element;
  /** The lyrics the song came with (to chart them by hand), if any. */
  lyrics?: readonly LyricsLine[];
}) {
  const change = (label: string, patch: SongFields) => props.onChange(label, patch);
  return (
    <Dialog open={props.open} onOpenChange={(open: boolean) => props.onOpenChange(open)}>
      <DialogContent class="w-[min(600px,calc(100vw-32px))]" data-testid="song-details">
        <DialogHeader>
          <DialogTitle>Song details</DialogTitle>
          <DialogDescription>
            What the song list shows, exported with the chart. Changes save as you go.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div class="grid grid-cols-2 gap-3">
            <Field
              label="Title"
              value={props.song.title}
              testid="song-title"
              save={(text) => (text.trim() ? change("Change title", { title: text.trim() }) : false)}
            />
            <Field
              label="Artist"
              value={props.song.artist}
              testid="song-artist"
              save={(text) => (text.trim() ? change("Change artist", { artist: text.trim() }) : false)}
            />
            <Field
              label="Languages"
              value={props.song.language.join(", ")}
              placeholder="English, German"
              testid="song-languages"
              save={(text) => change("Change languages", { language: listFrom(text) })}
            />
            <Field
              label="Year"
              value={props.song.year === null ? "" : String(props.song.year)}
              inputmode="numeric"
              testid="song-year"
              save={(text) => {
                const year = yearFrom(text);
                if (year === undefined) return false;
                change("Change year", { year });
              }}
            />
            <Field
              label="Genre"
              value={props.song.genre ?? ""}
              placeholder="e.g. Pop"
              testid="song-genre"
              save={(text) => change("Change genre", { genre: optional(text) })}
            />
            <Field
              label="Edition"
              value={props.song.edition ?? ""}
              placeholder="e.g. SingStar Pop"
              testid="song-edition"
              save={(text) => change("Change edition", { edition: optional(text) })}
            />
            <Field
              label="Creator"
              value={props.song.creator ?? ""}
              placeholder="Who made the chart"
              testid="song-creator"
              save={(text) => change("Change creator", { creator: optional(text) })}
            />
            <Field
              label="Tags"
              value={props.song.tags.join(", ")}
              placeholder="live, acoustic"
              testid="song-tags"
              save={(text) => change("Change tags", { tags: listFrom(text) })}
            />
            <Show when={props.singers.length > 1}>
              <For each={props.singers}>
                {(singer) => (
                  <Field
                    label={`Singer ${singer.index}`}
                    value={singer.name ?? ""}
                    placeholder={`P${singer.index}`}
                    testid={`singer-name-${singer.index}`}
                    save={(text) => props.onSingerName(singer.id, optional(text))}
                  />
                )}
              </For>
            </Show>
          </div>
          {props.files}
          {props.timing}
          <Show when={props.lyrics?.length ? props.lyrics : null}>
            {(lines) => (
              <div class="border-t border-popover-line pt-4">
                <Collapsible>
                  <CollapsibleTrigger
                    render={(triggerProps: JSX.ButtonHTMLAttributes<HTMLButtonElement>) => (
                      <button
                        type="button"
                        {...triggerProps}
                        class="group flex cursor-pointer items-center"
                        data-testid="lyrics-toggle"
                      >
                        <span class="flex items-center gap-1.5 eyebrow">
                          <ChevronRightIcon class="size-3 transition-transform group-data-panel-open:rotate-90" />
                          Lyrics ({lines().length} lines)
                        </span>
                      </button>
                    )}
                  />
                  <CollapsibleContent>
                    <div class="pt-2">
                      <LyricsList lines={lines()} />
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}
          </Show>
          <p class="m-0 text-[11px] text-muted-foreground" data-testid="song-grid">
            Chart grid: {formatNumber(props.bpm)} BPM, first beat at {formatSeconds(props.gap)}
          </p>
          <Show when={props.otherHeaders.length > 0}>
            <div class="flex flex-col gap-1.5 border-t border-popover-line pt-3">
              <span class="eyebrow">Other headers, kept for export</span>
              <ul class="m-0 flex list-none flex-col gap-1 p-0 font-mono text-[10.5px]">
                <For each={props.otherHeaders}>
                  {([key, value]) => (
                    <li class="flex min-w-0 gap-2">
                      <span class="shrink-0 text-sage-63">#{key}</span>
                      <span class="truncate text-muted-foreground" title={value}>
                        {value}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
        </DialogBody>
        {props.nested}
      </DialogContent>
    </Dialog>
  );
}
