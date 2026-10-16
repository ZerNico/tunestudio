/**
 * The piano roll's right-click menu. On a note it is for the selection (the note joins it unless it is in it already):
 * every action the keys have, with its key, so the menu also teaches them. On empty space: Paste and Select all.
 */
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import CheckIcon from "~icons/lucide/check";
import DeleteIcon from "~icons/lucide/delete";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { platform } from "~/lib/desktop";
import { NOTE_FLAGS, type NoteFlag } from "~/lib/editor/edits";

export interface NoteMenuActions {
  /** The menu is opening: whether it was over a note (which joins the selection). */
  open: () => boolean;
  canAutoPitch: () => boolean;
  autoPitch: () => void;
  canSplitAtPlayhead: () => boolean;
  splitAtPlayhead: () => void;
  canMerge: () => boolean;
  merge: () => void;
  flagOn: (flag: NoteFlag) => boolean;
  toggleFlag: (flag: NoteFlag) => void;
  cut: () => void;
  copy: () => void;
  paste: () => void;
  remove: () => void;
  selectAll: () => void;
}

const COMMAND = platform === "macos" ? "⌘" : "Ctrl+";

export function NoteMenu(props: { actions: NoteMenuActions; children: JSX.Element }) {
  const [onNote, setOnNote] = createSignal(false);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        class="flex min-h-0 min-w-0 flex-1"
        onContextMenu={() => setOnNote(props.actions.open())}
        data-testid="note-menu-trigger"
      >
        {props.children}
      </ContextMenuTrigger>
      <ContextMenuContent class="min-w-[200px]" data-testid="note-menu">
        <Show
          when={onNote()}
          fallback={
            <>
              <ContextMenuItem onClick={() => props.actions.paste()}>
                Paste
                <ContextMenuShortcut>{COMMAND}V</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onClick={() => props.actions.selectAll()}>
                Select all
                <ContextMenuShortcut>{COMMAND}A</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          }
        >
          <ContextMenuItem disabled={!props.actions.canAutoPitch()} onClick={() => props.actions.autoPitch()}>
            Auto pitch
            <ContextMenuShortcut>A</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!props.actions.canSplitAtPlayhead()}
            onClick={() => props.actions.splitAtPlayhead()}
          >
            Split at playhead
            <ContextMenuShortcut>{COMMAND}K</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!props.actions.canMerge()} onClick={() => props.actions.merge()}>
            Merge
            <ContextMenuShortcut>M</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <For each={NOTE_FLAGS}>
            {(item) => (
              // A plain row with the tick by its name: a check item keeps a column free for the tick on every row.
              <ContextMenuItem
                role="menuitemcheckbox"
                aria-checked={props.actions.flagOn(item.flag) ? "true" : "false"}
                onClick={() => props.actions.toggleFlag(item.flag)}
              >
                {item.label}
                <Show when={props.actions.flagOn(item.flag)}>
                  <CheckIcon class="size-3 text-primary" aria-hidden="true" />
                </Show>
                <ContextMenuShortcut>{item.key}</ContextMenuShortcut>
              </ContextMenuItem>
            )}
          </For>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => props.actions.cut()}>
            Cut
            <ContextMenuShortcut>{COMMAND}X</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => props.actions.copy()}>
            Copy
            <ContextMenuShortcut>{COMMAND}C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => props.actions.paste()}>
            Paste
            <ContextMenuShortcut>{COMMAND}V</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => props.actions.remove()}>
            Delete
            <ContextMenuShortcut>
              <Show when={platform === "macos"} fallback="Del">
                <DeleteIcon class="size-3" aria-label="Delete key" />
              </Show>
            </ContextMenuShortcut>
          </ContextMenuItem>
        </Show>
      </ContextMenuContent>
    </ContextMenu>
  );
}
