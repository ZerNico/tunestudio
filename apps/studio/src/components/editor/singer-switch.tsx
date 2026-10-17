/**
 * The singers, in the transport at the bottom. A solo chart offers Add singer; a duet shows one chip per singer: clicking it makes
 * that singer active (new notes, paste and line breaks go to them), its eye hides or shows them, and a double-click
 * renames them. Right-clicking a chip shows only that singer (or both again), renames or removes them. Removing a singer
 * with notes asks what to do with them.
 */
import { createSignal, For, Show } from "solid-js";
import EyeIcon from "~icons/lucide/eye";
import EyeOffIcon from "~icons/lucide/eye-off";
import UserPlusIcon from "~icons/lucide/user-plus";

import { Button } from "~/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Toggle } from "~/components/ui/toggle";
import { singerLabel } from "~/lib/editor/singers";
import type { SingerIndex } from "~/lib/editor/singers-view";
import type { EditorSinger } from "~/lib/native/types";

import { IconButton } from "./icon-button";

const noteCount = (singer: EditorSinger) => singer.lines.reduce((sum, line) => sum + line.notes.length, 0);

export function SingerSwitch(props: {
  singers: readonly EditorSinger[];
  /** The active singer's index. */
  active: number;
  isHidden: (index: number) => boolean;
  /** Adding or removing would get in the way of something running (Chart range, auto pitch). */
  busy: boolean;
  onChoose: (index: SingerIndex) => void;
  onHidden: (index: SingerIndex, hide: boolean) => void;
  onSolo: (index: SingerIndex) => void;
  onShowAll: () => void;
  /** Adds the second singer; returns its id, to name it right away. */
  onAdd: () => number | null;
  onRename: (id: number, name: string | null) => void;
  onRemove: (id: number, merge: boolean) => void;
}) {
  /** The singer (id) being renamed in its chip. */
  const [renaming, setRenaming] = createSignal<number | null>(null);
  const [removing, setRemoving] = createSignal<EditorSinger | null>(null);
  const other = (singer: EditorSinger) => props.singers.find((item) => item.id !== singer.id);
  const remove = (singer: EditorSinger) => {
    if (noteCount(singer) === 0) props.onRemove(singer.id, false);
    else setRemoving(singer);
  };
  const finishRename = (singer: EditorSinger, value: string | null) => {
    setRenaming(null);
    if (value === null) return;
    const name = value.trim() || null;
    if (name !== singer.name) props.onRename(singer.id, name);
  };

  return (
    <Show
      when={props.singers.length > 1}
      fallback={
        <IconButton
          label="Add singer"
          tooltip="Add a second singer for a duet"
          disabled={props.busy}
          onClick={() => {
            const id = props.onAdd();
            if (id !== null) setRenaming(id);
          }}
          testid="add-singer"
        >
          <UserPlusIcon />
        </IconButton>
      }
    >
      <div class="flex items-center gap-1" data-testid="singers">
        {/* Keyed by id: every edit makes new singer objects, and an open name field (with its focus) must stay. */}
        <For each={props.singers} keyed={(singer) => singer.id}>
          {(singer) => (
            <ContextMenu>
              <ContextMenuTrigger class="flex" data-testid={`singer-menu-trigger-${singer().index}`}>
                <div
                  data-singer={singer().index}
                  data-hidden={props.isHidden(singer().index) ? "" : undefined}
                  class="flex items-center rounded-lg border border-popover-line bg-field p-0.5"
                  data-testid="singer-chip"
                >
                  <Show
                    when={renaming() === singer().id}
                    fallback={
                      <Toggle
                        variant="segment"
                        size="segment"
                        pressed={props.active === singer().index && !props.isHidden(singer().index)}
                        onPressedChange={() => props.onChoose(singer().index)}
                        onDblClick={() => setRenaming(singer().id)}
                        aria-label={`${singerLabel(singer())}, P${singer().index}`}
                        data-testid={`singer-${singer().index}`}
                      >
                        <span
                          data-singer={singer().index}
                          class="size-2 rounded-full bg-primary data-[singer=2]:bg-violet-text"
                          aria-hidden="true"
                        />
                        <span
                          data-hidden={props.isHidden(singer().index) ? "" : undefined}
                          class="data-hidden:text-faint-foreground data-hidden:line-through"
                        >
                          {singerLabel(singer())}
                        </span>
                      </Toggle>
                    }
                  >
                    <Input
                      class="w-28"
                      value={singer().name ?? ""}
                      placeholder={`P${singer().index}`}
                      aria-label={`Name of P${singer().index}`}
                      ref={(element: HTMLInputElement) =>
                        queueMicrotask(() => {
                          element.focus();
                          element.select();
                        })
                      }
                      onKeyDown={(event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
                        if (event.key === "Enter") finishRename(singer(), event.currentTarget.value);
                        else if (event.key === "Escape") {
                          event.stopPropagation();
                          finishRename(singer(), null);
                        }
                      }}
                      onBlur={(event: FocusEvent & { currentTarget: HTMLInputElement }) => {
                        if (renaming() === singer().id) finishRename(singer(), event.currentTarget.value);
                      }}
                      data-testid="singer-name"
                    />
                  </Show>
                  <IconButton
                    label={
                      props.isHidden(singer().index) ? `Show ${singerLabel(singer())}` : `Hide ${singerLabel(singer())}`
                    }
                    disabled={
                      !props.isHidden(singer().index) && props.singers.some((item) => props.isHidden(item.index))
                    }
                    onClick={() => props.onHidden(singer().index, !props.isHidden(singer().index))}
                    testid={`singer-eye-${singer().index}`}
                  >
                    <Show when={props.isHidden(singer().index)} fallback={<EyeIcon class="size-3.5" />}>
                      <EyeOffIcon class="size-3.5" />
                    </Show>
                  </IconButton>
                </div>
              </ContextMenuTrigger>
              {/* Renaming: the name field keeps the focus the menu would give back to the chip. */}
              <ContextMenuContent
                class="min-w-[180px]"
                finalFocus={() => renaming() === null}
                data-testid="singer-menu"
              >
                <Show
                  when={props.singers.some((item) => props.isHidden(item.index))}
                  fallback={
                    <ContextMenuItem onClick={() => props.onSolo(singer().index)}>
                      Show only {singerLabel(singer())}
                    </ContextMenuItem>
                  }
                >
                  <ContextMenuItem onClick={() => props.onShowAll()}>Show both</ContextMenuItem>
                </Show>
                <ContextMenuItem onClick={() => setRenaming(singer().id)}>Rename</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" disabled={props.busy} onClick={() => remove(singer())}>
                  Remove {singerLabel(singer())}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )}
        </For>
      </div>
      <Dialog
        open={removing() !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setRemoving(null);
        }}
      >
        <DialogContent class="w-[min(420px,calc(100vw-32px))]" data-testid="remove-singer-dialog">
          <Show when={removing()}>
            {(singer) => (
              <>
                <DialogHeader>
                  <DialogTitle>Remove {singerLabel(singer())}?</DialogTitle>
                  <DialogDescription>
                    {singerLabel(singer())} has {noteCount(singer())} {noteCount(singer()) === 1 ? "note" : "notes"}.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setRemoving(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setRemoving(null);
                      props.onRemove(singer().id, false);
                    }}
                  >
                    Delete them
                  </Button>
                  <Button
                    onClick={() => {
                      setRemoving(null);
                      props.onRemove(singer().id, true);
                    }}
                  >
                    Move them to {singerLabel(other(singer()) ?? singer())}
                  </Button>
                </DialogFooter>
              </>
            )}
          </Show>
        </DialogContent>
      </Dialog>
    </Show>
  );
}
