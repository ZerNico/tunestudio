import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import ChevronDownIcon from "~icons/lucide/chevron-down";
import DownloadIcon from "~icons/lucide/download";
import FileTextIcon from "~icons/lucide/file-text";
import FolderIcon from "~icons/lucide/folder";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

/**
 * The title bar's Export menu: for games (a song folder: the chart with its audio, video and cover), or for USDB (the
 * chart's text, to paste into its form).
 */
export function ExportMenu(props: { busy: boolean; onSongFolder: () => void; onUsdb: () => void }) {
  return (
    <DropdownMenu>
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
