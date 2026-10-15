/**
 * The piano roll's right-click menu. On a note it is for the selection (the note joins it unless it is in it already):
 * every action the keys have, with its key, so the menu also teaches them. On empty space: Paste and Select all.
 */
import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import DeleteIcon from "~icons/lucide/delete";

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import { platform } from "~/lib/desktop";
import type { NoteFlag } from "~/lib/editor/edits";

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
/** The plain items' shortcuts sit as far in as the check items' (their right padding is wider, for the tick). */
const KEY = "mr-6";

const FLAGS: { flag: NoteFlag; label: string; key: string }[] = [
  { flag: "golden", label: "Golden", key: "G" },
  { flag: "rap", label: "Rap", key: "R" },
  { flag: "freestyle", label: "Freestyle", key: "F" },
];

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
                <ContextMenuShortcut class={KEY}>{COMMAND}V</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onClick={() => props.actions.selectAll()}>
                Select all
                <ContextMenuShortcut class={KEY}>{COMMAND}A</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          }
        >
          <ContextMenuItem disabled={!props.actions.canAutoPitch()} onClick={() => props.actions.autoPitch()}>
            Auto pitch
            <ContextMenuShortcut class={KEY}>A</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!props.actions.canSplitAtPlayhead()}
            onClick={() => props.actions.splitAtPlayhead()}
          >
            Split at playhead
            <ContextMenuShortcut class={KEY}>{COMMAND}K</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!props.actions.canMerge()} onClick={() => props.actions.merge()}>
            Merge
            <ContextMenuShortcut class={KEY}>M</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <For each={FLAGS}>
            {(item) => (
              <ContextMenuCheckboxItem
                checked={props.actions.flagOn(item.flag)}
                onCheckedChange={() => props.actions.toggleFlag(item.flag)}
                closeOnClick
              >
                {item.label}
                <ContextMenuShortcut>{item.key}</ContextMenuShortcut>
              </ContextMenuCheckboxItem>
            )}
          </For>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => props.actions.cut()}>
            Cut
            <ContextMenuShortcut class={KEY}>{COMMAND}X</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => props.actions.copy()}>
            Copy
            <ContextMenuShortcut class={KEY}>{COMMAND}C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => props.actions.paste()}>
            Paste
            <ContextMenuShortcut class={KEY}>{COMMAND}V</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => props.actions.remove()}>
            Delete
            <ContextMenuShortcut class={KEY}>
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
