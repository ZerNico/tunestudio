import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import ChevronDownIcon from "~icons/lucide/chevron-down";
import DownloadIcon from "~icons/lucide/download";
import FileTextIcon from "~icons/lucide/file-text";
import FolderIcon from "~icons/lucide/folder";
import Gamepad2Icon from "~icons/lucide/gamepad-2";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { type Game, tryLabel } from "~/lib/games";

/**
 * The title bar's Export menu: for games (a song folder: the chart with its audio, video and cover), for USDB (the
 * chart's text, to paste into its form), or straight into a game to try the chart there, one item per game available.
 * With none, a plain "Try in game" item lets main say so.
 */
export function ExportMenu(props: {
  busy: boolean;
  /** The games available, in `GAMES` order. */
  games: readonly Game[];
  /** The game the try key starts, whose item shows the key. */
  shortcutGame: Game | null;
  /** The try key, as shown. */
  tryShortcut: string;
  onSongFolder: () => void;
  onUsdb: () => void;
  /** Tries the song in `game`; without one, in the game main picks. */
  onTryInGame: (game?: Game) => void;
  /** The menu opened (a game may have been added in the settings). */
  onOpen?: () => void;
}) {
  return (
    <DropdownMenu
      onOpenChange={(open: boolean) => {
        if (open) props.onOpen?.();
      }}
    >
      <DropdownMenuTrigger
        disabled={props.busy}
        render={(triggerProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
          <Button variant="ghost" size="sm" {...triggerProps} data-testid="export-song">
            <Show when={props.busy} fallback={<DownloadIcon />}>
              <LoaderCircleIcon class="animate-spin" />
            </Show>
            Export
            <ChevronDownIcon class="size-3 text-muted-foreground" />
          </Button>
        )}
      />
      <DropdownMenuContent align="end" data-testid="export-menu">
        <DropdownMenuItem onClick={() => props.onSongFolder()} data-testid="export-folder">
          <FolderIcon />
          Export for games
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => props.onUsdb()} data-testid="export-usdb">
          <FileTextIcon />
          Export for USDB
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <For
          each={props.games}
          fallback={
            <DropdownMenuItem onClick={() => props.onTryInGame()} data-testid="try-in-game">
              <Gamepad2Icon />
              Try in game
              <DropdownMenuShortcut>{props.tryShortcut}</DropdownMenuShortcut>
            </DropdownMenuItem>
          }
        >
          {(game) => (
            <DropdownMenuItem onClick={() => props.onTryInGame(game)} data-testid={`try-in-${game}`}>
              <Gamepad2Icon />
              {tryLabel(game)}
              <Show when={game === props.shortcutGame}>
                <DropdownMenuShortcut>{props.tryShortcut}</DropdownMenuShortcut>
              </Show>
            </DropdownMenuItem>
          )}
        </For>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
