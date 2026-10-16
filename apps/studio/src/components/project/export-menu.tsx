import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import ChevronDownIcon from "~icons/lucide/chevron-down";
import DownloadIcon from "~icons/lucide/download";
import FileTextIcon from "~icons/lucide/file-text";
import FolderIcon from "~icons/lucide/folder";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { Button } from "~/components/ui/button";
import { menuItemClass } from "~/components/ui/menu-classes";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";

/** One way to export, as the menu offers it. */
function ExportItem(props: {
  icon: JSX.Element;
  title: string;
  description: string;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      type="button"
      class={`${menuItemClass} w-full cursor-pointer items-start text-left hover:bg-sage-23 focus-visible:bg-sage-23`}
      onClick={() => props.onClick()}
      data-testid={props.testid}
    >
      <span class="mt-0.5">{props.icon}</span>
      <span class="flex flex-col gap-0.5">
        <span class="text-[11.5px] font-medium text-foreground">{props.title}</span>
        <span class="text-[10.5px] leading-snug text-popover-muted">{props.description}</span>
      </span>
    </button>
  );
}

/**
 * The title bar's Export menu: the song folder for UltraStar games (the chart with its audio, video and cover), or the
 * chart's text for USDB. A Popover, since base-ui-solid's Menu doesn't open under Solid 2 yet (AGENTS.md).
 */
export function ExportMenu(props: {
  busy: boolean;
  onSongFolder: () => void;
  onUsdb: () => void;
  /** The song has no YouTube video: USDB's text can't say where its audio is. */
  noVideoLink: boolean;
}) {
  const [open, setOpen] = createSignal(false);
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <Popover open={open()} onOpenChange={(next: boolean) => setOpen(next)}>
      <PopoverTrigger
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
      <PopoverContent align="end" class="w-80" data-testid="export-menu">
        <div class="flex flex-col gap-0.5">
          <ExportItem
            icon={<FolderIcon />}
            title="Song folder…"
            description="The chart with its audio, video and cover, for UltraStar games."
            onClick={() => choose(props.onSongFolder)}
            testid="export-folder"
          />
          <ExportItem
            icon={<FileTextIcon />}
            title="Text for USDB…"
            description={
              props.noVideoLink
                ? "The chart alone, to paste into USDB. Add the song's YouTube video in Song details first, so usdb_syncer finds its audio."
                : "The chart alone, to paste into USDB, with the song's YouTube video for usdb_syncer."
            }
            onClick={() => choose(props.onUsdb)}
            testid="export-usdb"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
