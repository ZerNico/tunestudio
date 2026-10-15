import { getRouteApi, useNavigate, useRouter } from "@tanstack/solid-router";
import { createSignal, Show } from "solid-js";
import DownloadIcon from "~icons/lucide/download";
import FolderSearchIcon from "~icons/lucide/folder-search";
import LoaderCircleIcon from "~icons/lucide/loader-circle";
import XIcon from "~icons/lucide/x";

import { ProjectCover } from "~/components/home/project-cover";
import { AudioPreview } from "~/components/project/audio-preview";
import { MakeChart } from "~/components/project/make-chart";
import {
  ChartStats,
  ImportNotes,
  LyricsList,
  MediaList,
  Panel,
  SongDetails,
} from "~/components/project/project-panels";
import { ReplaceExportDialog } from "~/components/project/replace-export-dialog";
import { TitleBar } from "~/components/title-bar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";
import { revealLabel } from "~/lib/desktop";
import { formatFileSize, formatFullDate } from "~/lib/format";
import { native } from "~/lib/native/client";
import { errorMessage } from "~/lib/native/errors";

const route = getRouteApi("/project/$id");

function reveal(path: string) {
  native.files.reveal({ path }).catch((error: unknown) => {
    toast.add({ type: "error", title: "Couldn't show it", description: errorMessage(error) });
  });
}

/**
 * An open project. There is no editor yet: the screen shows what the project holds (song,
 * chart, media, import notes), plays its audio, makes the chart from the vocals and lyrics, and
 * exports it as an UltraStar song.
 */
export default function ProjectScreen() {
  const overview = route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const [exporting, setExporting] = createSignal(false);
  const [replacing, setReplacing] = createSignal<{ folder: string; existing: string } | null>(null);

  const media = (role: string) => overview().media.find((item) => item.role === role);
  const title = () => overview().song.title || "Untitled";
  const artist = () => overview().song.artist || "Unknown artist";

  const close = async () => {
    await native.project.close({ id: overview().id }).catch((error: unknown) => console.error(error));
    void navigate({ to: "/" });
  };

  const exportTo = async (folder: string, replace: boolean) => {
    setExporting(true);
    try {
      const result = await native.project.exportSong({ id: overview().id, folder, replace });
      if (result.status === "exists") {
        setReplacing({ folder, existing: result.folder });
        return;
      }
      toast.add({
        type: "success",
        title: "Exported the UltraStar song",
        description: [
          `${result.files.length} files in ${result.folder}.`,
          result.warnings.length > 0 ? result.warnings[0] : "",
        ].join(" "),
        actionProps: { children: revealLabel, onClick: () => reveal(result.folder) },
      });
    } catch (error) {
      toast.add({ type: "error", title: "Couldn't export the song", description: errorMessage(error) });
    } finally {
      setExporting(false);
    }
  };

  const chooseExport = async () => {
    try {
      const folder = await native.dialogs.chooseExportFolder();
      if (folder) await exportTo(folder, false);
    } catch (error) {
      toast.add({ type: "error", title: "Couldn't export the song", description: errorMessage(error) });
    }
  };

  return (
    <div class="flex h-dvh min-h-0 flex-col bg-background" data-testid="project">
      <TitleBar>
        <Button variant="ghost" size="sm" onClick={() => void close()} data-testid="close-project">
          <XIcon />
          Close project
        </Button>
      </TitleBar>
      <main class="min-h-0 flex-1 scrollbar-thin overflow-y-auto" aria-labelledby="project-title">
        <div class="mx-auto flex max-w-[1100px] flex-col gap-6 px-10 pt-9 pb-16">
          <header class="flex items-end gap-6">
            <ProjectCover id={overview().path} src={media("cover")?.url} class="size-[148px] rounded-xl" />
            <div class="flex min-w-0 flex-1 flex-col gap-2 pb-1">
              <p class="m-0 eyebrow text-sage-65">Project</p>
              <h1
                id="project-title"
                class="m-0 truncate text-[27px] leading-tight font-[550] tracking-[-0.8px] text-foreground"
              >
                {title()}
              </h1>
              <p class="m-0 truncate text-[14px] text-muted-foreground" data-testid="project-artist">
                {artist()}
              </p>
              <div class="flex flex-wrap items-center gap-1.5">
                <Show when={overview().singers.length > 1}>
                  <Badge variant="violet">Duet</Badge>
                </Show>
                <Show when={overview().song.language.length > 0}>
                  <Badge variant="lime">{overview().song.language.join(", ")}</Badge>
                </Show>
                <Show when={overview().song.year}>{(year) => <Badge variant="secondary">{year()}</Badge>}</Show>
                <Show when={overview().song.genre}>{(genre) => <Badge variant="secondary">{genre()}</Badge>}</Show>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-2 pb-1">
              <Button variant="outline" onClick={() => reveal(overview().path)}>
                <FolderSearchIcon />
                {revealLabel}
              </Button>
              <Button onClick={() => void chooseExport()} disabled={exporting()} data-testid="export-song">
                <Show when={exporting()} fallback={<DownloadIcon />}>
                  <LoaderCircleIcon class="animate-spin" />
                </Show>
                Export UltraStar song…
              </Button>
            </div>
          </header>

          <p
            class="m-0 flex min-w-0 items-center gap-2 font-mono text-[10.5px] text-faint-foreground"
            data-testid="project-path"
          >
            <span class="truncate [direction:rtl]" title={overview().path}>
              <bdi>{overview().path}</bdi>
            </span>
            <span aria-hidden="true">·</span>
            <span class="shrink-0">{formatFileSize(overview().fileSize)}</span>
            <Show when={overview().createdAt}>
              {(createdAt) => (
                <>
                  <span aria-hidden="true">·</span>
                  <span class="shrink-0">Created {formatFullDate(createdAt())}</span>
                </>
              )}
            </Show>
          </p>

          <Show when={media("audio")}>{(audio) => <AudioPreview src={audio().url} label={title()} />}</Show>

          <div class="grid grid-cols-2 items-start gap-4">
            <Panel title="Chart" id="chart">
              <>
                <ChartStats overview={overview()} />
                <MakeChart overview={overview()} onDone={() => void router.invalidate()} />
              </>
            </Panel>
            <Panel title="Song details" id="song">
              <SongDetails overview={overview()} />
            </Panel>
          </div>

          <Panel
            title="Media"
            id="media"
            aside={<span class="text-[11px] text-muted-foreground">Stored in the project, exactly as imported</span>}
          >
            <MediaList media={overview().media} />
          </Panel>

          <Show when={overview().lyrics}>
            {(lyrics) => (
              <Panel
                title="Lyrics"
                id="lyrics"
                aside={
                  <span class="text-[11px] text-muted-foreground">
                    {lyrics().lines.length} lines
                    {lyrics().source === "lrclib" ? " from LRCLIB" : ", written in Tune Studio"}
                    {lyrics().synced ? ", synced" : ""}
                  </span>
                }
              >
                <LyricsList lines={lyrics().lines} />
              </Panel>
            )}
          </Show>

          <Show when={overview().importWarnings.length > 0}>
            <Panel
              title="Import notes"
              id="import"
              aside={
                <Show when={overview().importedFrom}>
                  {(from) => (
                    <span class="max-w-[420px] truncate font-mono text-[10.5px] text-faint-foreground" title={from()}>
                      {from()}
                    </span>
                  )}
                </Show>
              }
            >
              <ImportNotes warnings={overview().importWarnings} />
            </Panel>
          </Show>
        </div>
      </main>

      <ReplaceExportDialog
        target={replacing()}
        onCancel={() => setReplacing(null)}
        onReplace={(folder) => {
          setReplacing(null);
          void exportTo(folder, true);
        }}
      />
    </div>
  );
}
