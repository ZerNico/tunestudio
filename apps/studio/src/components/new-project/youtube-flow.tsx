import type { JSX } from "@solidjs/web";
import { createSignal, Match, Show, Switch } from "solid-js";
import LoaderCircleIcon from "~icons/lucide/loader-circle";
import YoutubeIcon from "~icons/lucide/youtube";

import { Note } from "~/components/home/song-import-flow";
import { ToolsStep } from "~/components/home/tools-step";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { formatDuration } from "~/lib/format";
import { native } from "~/lib/native/client";
import { LONGEST_SONG_SECONDS } from "~/lib/native/contract";
import { errorMessage } from "~/lib/native/errors";
import type { ImportProgress, ModelStatus, OpenedProject, YoutubeVideo } from "~/lib/native/types";
import { AUDIO_FORMAT_LABELS, type Settings, VIDEO_FORMAT_LABELS } from "~/lib/settings";

import { Checklist } from "./checklist";
import { CoverPicker } from "./cover-picker";
import { createFlow, FlowView, type Stage } from "./flow-runner";
import { LanguageSelect } from "./language-select";
import { createNewProject, type NewProject } from "./new-project";
import { follow } from "./progress";
import { chartStage, finishStage, lyricsStage } from "./stages";

/** The stages a YouTube project goes through, as the dialog's header lists them. */
export const YOUTUBE_STAGES = ["Song", "Lyrics", "Chart", "Finish"];

/** What the settings will download, in a few words. */
export function describeDownload(settings: Settings): string {
  const audio =
    settings.audio.format === "m4a" || settings.audio.format === "opus"
      ? AUDIO_FORMAT_LABELS[settings.audio.format]
      : `${AUDIO_FORMAT_LABELS[settings.audio.format]} ${settings.audio.bitrate} kbps`;
  if (!settings.video.download) return `Audio as ${audio}, without the video`;
  return `Audio as ${audio}, video as ${VIDEO_FORMAT_LABELS[settings.video.format]} up to ${settings.video.maxResolution}p`;
}

/**
 * The download step's checklist, in the order main reports it. The voice separation model is
 * downloaded the first time only.
 */
export function downloadTasks(settings: Settings | null, models: ModelStatus | null): string[] {
  return [
    "Downloading the audio",
    ...(settings?.video.download === false ? [] : ["Downloading the video"]),
    ...(settings && settings.audio.normalization !== "off" ? ["Adjusting the volume"] : []),
    ...(models && !models.separation ? ["Getting the voice separation model"] : []),
    "Separating the voice",
  ];
}

/** Looking the video up: the download tools first, then yt-dlp. */
type Lookup =
  | { status: "tools" }
  | { status: "looking" }
  | { status: "failed"; message: string }
  | { status: "found"; video: YoutubeVideo };

/**
 * The Song stage of a YouTube project: the video looked up, the song's details, cover and language; Next downloads the
 * song into a draft and separates the voice (once: going back and on keeps it).
 */
function youtubeSongStage(
  project: NewProject,
  videoId: () => string,
  lookup: () => Lookup,
  onLookUp: () => void,
): Stage {
  const [downloading, setDownloading] = createSignal<ImportProgress | null | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  const video = () => {
    const current = lookup();
    return current.status === "found" ? current.video : undefined;
  };
  const failed = () => {
    const current = lookup();
    return current.status === "failed" ? current : undefined;
  };
  const tooLong = () => (video()?.duration ?? 0) > LONGEST_SONG_SECONDS;
  return {
    id: "song",
    tag: "Song",
    canAdvance: () =>
      video() !== undefined && project.artist().trim() !== "" && project.title().trim() !== "" && !tooLong(),
    run: async (signal) => {
      setError(null);
      if (project.draft()) return true;
      setDownloading(null);
      try {
        await project.checkModels();
        const downloaded = await follow(
          () => native.youtube.download({ videoId: videoId() }, { signal }),
          signal,
          setDownloading,
          // Finished as it was stopped: kept, or thrown away if the dialog closed.
          project.setDraft,
        );
        if (!downloaded) return false;
        project.setDraft(downloaded);
        return true;
      } catch (failure) {
        setError(errorMessage(failure));
        return false;
      } finally {
        setDownloading(undefined);
      }
    },
    body: () => (
      <Switch>
        <Match when={lookup().status === "tools"}>
          <ToolsStep onReady={onLookUp} />
        </Match>
        <Match when={lookup().status === "looking"}>
          <p class="m-0 flex items-center gap-2 text-[11.5px] text-popover-foreground" aria-live="polite">
            <LoaderCircleIcon class="size-4 animate-spin text-primary" />
            Looking up the video…
          </p>
        </Match>
        <Match when={failed()}>
          {(lookupFailed) => (
            <Note tone="error" testid="youtube-error">
              <span class="flex items-center gap-3">
                <span class="flex-1">{lookupFailed().message}</span>
                <Button variant="outline" size="xs" onClick={onLookUp} data-testid="youtube-retry">
                  Try again
                </Button>
              </span>
            </Note>
          )}
        </Match>
        <Match when={downloading() !== undefined}>
          <Checklist
            title="Downloading the song"
            hint="This takes a minute or two. The lyrics come next; Back stops it."
            label="Download"
            testid="youtube-progress"
            tasks={downloadTasks(project.settings(), project.models())}
            progress={downloading() ?? null}
          />
        </Match>
        <Match when={video()}>
          <div class="grid grid-cols-2 gap-3">
            <Label layout="stacked">
              Artist
              <Input
                value={project.artist()}
                onInput={(event) => project.setArtist(event.currentTarget.value)}
                data-testid="youtube-artist"
              />
            </Label>
            <Label layout="stacked">
              Title
              <Input
                value={project.title()}
                onInput={(event) => project.setTitle(event.currentTarget.value)}
                data-testid="youtube-title"
              />
            </Label>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-[11.5px] text-popover-foreground">Sung in</span>
            <LanguageSelect value={project.chosenLanguage()} onChange={project.setLanguage} />
            <span class="text-[10.5px] text-popover-muted">The lyrics are looked for, heard and charted in it.</span>
          </div>
          <CoverPicker
            covers={project.covers()}
            thumbnail={video()?.thumbnail ?? null}
            custom={project.customCover()}
            selected={project.cover()}
            onSelect={project.setCover}
            onChooseFile={() => void project.chooseCoverFile()}
          />
          <Show when={tooLong()}>
            <Note tone="error" testid="youtube-too-long">
              This video is longer than {LONGEST_SONG_SECONDS / 60} minutes, too long for a song. Choose the song's own
              video.
            </Note>
          </Show>
          <Show when={error()}>
            {(message) => (
              <Note tone="error" testid="youtube-error">
                {message()}
              </Note>
            )}
          </Show>
          <Show when={project.settings()}>
            {(current) => (
              <p class="m-0 text-[10.5px] text-popover-muted" data-testid="youtube-download-summary">
                {describeDownload(current())}. You can change this in Settings.
              </p>
            )}
          </Show>
        </Match>
      </Switch>
    ),
  };
}

/**
 * A new project from a YouTube video, stage by stage: the song (its details, cover and language; Next downloads it),
 * the lyrics, the chart, and a summary whose "Create project…" asks where to save and writes the project. Until then
 * everything lives in a draft that is thrown away when the dialog closes.
 */
export function YoutubeFlow(props: {
  videoId: string;
  url: string;
  /** False once the dialog closes. */
  open: boolean;
  header: (stage: number) => JSX.Element;
  onOpened: (project: OpenedProject) => void;
}) {
  const project = createNewProject();
  const [lookup, setLookup] = createSignal<Lookup>({ status: "tools" });

  const lookUp = async () => {
    setLookup({ status: "looking" });
    try {
      const found = await native.youtube.inspect({ videoId: props.videoId });
      project.setBasis({
        artist: found.artist,
        title: found.songTitle,
        duration: found.duration,
        year: found.year,
        language: found.language,
      });
      setLookup({ status: "found", video: found });
    } catch (failure) {
      setLookup({ status: "failed", message: errorMessage(failure) });
    }
  };

  const flow = createFlow([
    youtubeSongStage(
      project,
      () => props.videoId,
      lookup,
      () => void lookUp(),
    ),
    lyricsStage(project),
    chartStage(project),
    finishStage(project, {
      sourcePicture: "The video's thumbnail",
      onOpened: (opened) => props.onOpened(opened),
    }),
  ]);
  const video = () => {
    const current = lookup();
    return current.status === "found" ? current.video : undefined;
  };

  return (
    <FlowView
      flow={flow}
      open={props.open}
      busy={lookup().status === "looking"}
      header={props.header}
      source={
        <Show
          when={video()}
          fallback={
            <div class="flex items-center gap-3 rounded-[10px] border border-popover-line bg-popover-well/50 p-3">
              <span class="flex size-9 shrink-0 items-center justify-center rounded-md bg-youtube-soft text-youtube">
                <YoutubeIcon class="size-4" />
              </span>
              <span class="min-w-0 truncate font-mono text-[10.5px] text-popover-muted" title={props.url}>
                {props.url}
              </span>
            </div>
          }
        >
          {(found) => <VideoCard video={found()} />}
        </Show>
      }
    />
  );
}

function VideoCard(props: { video: YoutubeVideo }) {
  return (
    <div
      class="flex items-center gap-3 rounded-[10px] border border-popover-line bg-popover-well/50 p-2.5"
      data-testid="youtube-video"
    >
      <Show
        when={props.video.thumbnail}
        fallback={
          <span class="flex aspect-video w-[112px] shrink-0 items-center justify-center rounded-md bg-youtube-soft text-youtube">
            <YoutubeIcon class="size-5" />
          </span>
        }
      >
        {(thumbnail) => (
          <img src={thumbnail()} alt="" class="aspect-video w-[112px] shrink-0 rounded-md object-cover" />
        )}
      </Show>
      <div class="flex min-w-0 flex-col gap-1">
        <span class="line-clamp-2 text-[12px] leading-snug font-medium text-foreground" title={props.video.title}>
          {props.video.title}
        </span>
        <span class="truncate text-[10.5px] text-popover-muted">
          {props.video.channel}
          <Show when={props.video.duration}>{(duration) => <> · {formatDuration(duration())}</>}</Show>
        </span>
      </div>
    </div>
  );
}
