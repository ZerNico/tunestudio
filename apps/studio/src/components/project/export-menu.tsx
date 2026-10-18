import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
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
 * chart's text, to paste into its form), or straight into a game to try the chart there.
 */
export function ExportMenu(props: {
  busy: boolean;
  /** The game "Try in game" starts. */
  game: Game;
  /** Its key, as shown. */
  tryShortcut: string;
  onSongFolder: () => void;
  onUsdb: () => void;
  onTryInGame: () => void;
  /** The menu opened (the game may have changed in the settings). */
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
        <DropdownMenuItem onClick={() => props.onTryInGame()} data-testid="try-in-game">
          <Gamepad2Icon />
          {tryLabel(props.game)}
          <DropdownMenuShortcut>{props.tryShortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
