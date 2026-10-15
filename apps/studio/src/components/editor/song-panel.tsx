import { Show } from "solid-js";
import FolderSearchIcon from "~icons/lucide/folder-search";

import { ProjectCover } from "~/components/home/project-cover";
import { MakeChart } from "~/components/project/make-chart";
import {
  ChartStats,
  ImportNotes,
  LyricsList,
  MediaList,
  Panel,
  SongDetails,
} from "~/components/project/project-panels";
import { Button } from "~/components/ui/button";
import { revealLabel } from "~/lib/desktop";
import { formatFileSize } from "~/lib/format";
import type { ProjectOverview } from "~/lib/native/types";

/**
 * Everything about the song that isn't needed while editing, in a panel at the editor's right: the cover, the chart
 * (and making it), the song's details, its media, lyrics and import notes.
 */
export function SongPanel(props: { overview: ProjectOverview; onReveal: () => void; onChartMade: () => void }) {
  const cover = () => props.overview.media.find((item) => item.role === "cover")?.url;
  return (
    <aside
      class="flex w-[360px] shrink-0 scrollbar-thin flex-col gap-4 overflow-y-auto border-l border-border bg-background p-4"
      aria-label="Song"
      data-testid="song-panel"
    >
      <div class="flex items-center gap-3">
        <ProjectCover id={props.overview.path} src={cover()} class="size-16 shrink-0 rounded-lg" />
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="truncate text-[14px] font-semibold text-foreground">{props.overview.song.title}</span>
          <span class="truncate text-[12px] text-muted-foreground" data-testid="project-artist">
            {props.overview.song.artist}
          </span>
          <span class="truncate font-mono text-[10px] text-faint-foreground" title={props.overview.path}>
            {formatFileSize(props.overview.fileSize)}
          </span>
        </div>
      </div>
      <Button variant="outline" size="sm" class="self-start" onClick={() => props.onReveal()}>
        <FolderSearchIcon />
        {revealLabel}
      </Button>
      <Panel title="Chart" id="chart">
        <>
          <ChartStats overview={props.overview} />
          <MakeChart overview={props.overview} onDone={() => props.onChartMade()} />
        </>
      </Panel>
      <Panel title="Song details" id="song">
        <SongDetails overview={props.overview} />
      </Panel>
      <Panel title="Media" id="media">
        <MediaList media={props.overview.media} />
      </Panel>
      <Show when={props.overview.lyrics}>
        {(lyrics) => (
          <Panel title="Lyrics" id="lyrics">
            <LyricsList lines={lyrics().lines} />
          </Panel>
        )}
      </Show>
      <Show when={props.overview.importWarnings.length > 0}>
        <Panel title="Import notes" id="import">
          <ImportNotes warnings={props.overview.importWarnings} />
        </Panel>
      </Show>
    </aside>
  );
}
