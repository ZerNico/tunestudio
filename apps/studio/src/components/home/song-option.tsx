import FileMusicIcon from "~icons/lucide/file-music";
import FolderOpenIcon from "~icons/lucide/folder-open";

import { Button } from "~/components/ui/button";

import { StartOption } from "./start-option";

/** Import an UltraStar song you already have, e.g. a USDB download, into a new project. */
export function SongOption(props: { onChoose: () => void }) {
  return (
    <StartOption
      id="song"
      tone="violet"
      icon={<FolderOpenIcon />}
      title="Import an UltraStar song"
      description="Bring in a chart you already have, from USDB or your library."
    >
      <Button variant="secondary" size="lg" class="w-full" onClick={() => props.onChoose()} data-testid="song-choose">
        <FileMusicIcon />
        Choose song…
      </Button>
      <p class="m-0 min-h-[2lh] text-[11px] text-faint-foreground">
        A song folder or its .txt chart. Or drop it anywhere.
      </p>
    </StartOption>
  );
}
