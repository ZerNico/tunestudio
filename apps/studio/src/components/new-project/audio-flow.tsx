import type { JSX } from "@solidjs/web";
import { createSignal, Match, Show, Switch } from "solid-js";
import FileAudioIcon from "~icons/lucide/file-audio";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { Note } from "~/components/home/song-import-flow";
import { ToolsStep } from "~/components/home/tools-step";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { formatDuration, formatFileSize } from "~/lib/format";
import { type AudioFileSummary, COPYING_THE_SONG } from "~/lib/import-files";
import { native } from "~/lib/native/client";
import { errorMessage } from "~/lib/native/errors";
import type { AudioFileDetails, ImportProgress, ModelStatus, OpenedProject } from "~/lib/native/types";

import { Checklist } from "./checklist";
import { CoverPicker } from "./cover-picker";
import { createFlow, FlowView, type Stage } from "./flow-runner";
import { LanguageSelect } from "./language-select";
import { createNewProject, type NewProject } from "./new-project";
import { follow } from "./progress";
import { chartStage, finishStage, lyricsStage } from "./stages";

/** The stages a project from an audio file goes through, as the dialog's header lists them. */
export const AUDIO_STAGES = ["Song", "Lyrics", "Chart", "Finish"];

/** The import step's checklist, in the order main reports it. The voice separation model is downloaded once. */
export function importTasks(models: ModelStatus | null): string[] {
  return [
    COPYING_THE_SONG,
    ...(models && !models.separation ? ["Getting the voice separation model"] : []),
    "Separating the voice",
  ];
}

/** Reading the file: FFmpeg first, then what the file says about itself. */
type Reading =
  | { status: "tools" }
  | { status: "reading" }
  | { status: "failed"; message: string }
  | { status: "read"; details: AudioFileDetails };

/**
 * The Song stage of a project from an audio file: the file read, the song's details, cover and language; Next copies
 * the file into a draft as it is and separates the voice (once: going back and on keeps it).
 */
function audioSongStage(project: NewProject, path: () => string, reading: () => Reading, onRead: () => void): Stage {
  const [importing, setImporting] = createSignal<ImportProgress | null | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  const details = () => {
    const current = reading();
    return current.status === "read" ? current.details : undefined;
  };
  const failed = () => {
    const current = reading();
    return current.status === "failed" ? current : undefined;
  };
  return {
    id: "song",
    tag: "Song",
    canAdvance: () => details() !== undefined && project.artist().trim() !== "" && project.title().trim() !== "",
    run: async (signal) => {
      setError(null);
      if (project.draft()) return true;
      setImporting(null);
      try {
        await project.checkModels();
        const imported = await follow(
          () => native.audio.import({ path: path() }, { signal }),
          signal,
          setImporting,
          // Finished as it was stopped: kept, or thrown away if the dialog closed.
          project.setDraft,
        );
        if (!imported) return false;
        project.setDraft(imported);
        return true;
      } catch (failure) {
        setError(errorMessage(failure));
        return false;
      } finally {
        setImporting(undefined);
      }
    },
    body: () => (
      <Switch>
        <Match when={reading().status === "tools"}>
          <ToolsStep tools={["ffmpeg"]} onReady={onRead} />
        </Match>
        <Match when={reading().status === "reading"}>
          <p class="m-0 flex items-center gap-2 text-[11.5px] text-popover-foreground" aria-live="polite">
            <LoaderCircleIcon class="size-4 animate-spin text-primary" />
            Reading the file…
          </p>
        </Match>
        <Match when={failed()}>
          {(readFailed) => (
            <Note tone="error" testid="audio-error">
              <span class="flex items-center gap-3">
                <span class="flex-1">{readFailed().message}</span>
                <Button variant="outline" size="xs" onClick={onRead} data-testid="audio-retry">
                  Try again
                </Button>
              </span>
            </Note>
          )}
        </Match>
        <Match when={importing() !== undefined}>
          <Checklist
            title="Preparing the song"
            hint="This takes a minute or two."
            label="Preparing"
            testid="audio-progress"
            tasks={importTasks(project.models())}
            progress={importing() ?? null}
          />
        </Match>
        <Match when={details()}>
          {(file) => (
            <>
              <div class="grid grid-cols-2 gap-3">
                <Label layout="stacked">
                  Artist
                  <Input
                    value={project.artist()}
                    onInput={(event) => project.setArtist(event.currentTarget.value)}
                    data-testid="audio-artist"
                  />
                </Label>
                <Label layout="stacked">
                  Title
                  <Input
                    value={project.title()}
                    onInput={(event) => project.setTitle(event.currentTarget.value)}
                    data-testid="audio-title"
                  />
                </Label>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-[11.5px] text-popover-foreground">Sung in</span>
                <LanguageSelect value={project.chosenLanguage()} onChange={project.setLanguage} />
              </div>
              <CoverPicker
                covers={project.covers()}
                own={
                  file().artwork
                    ? {
                        label: "The file's artwork",
                        hint: "The artwork in the audio file",
                        image: file().artwork,
                        placeholder: <FileAudioIcon class="size-5" />,
                      }
                    : null
                }
                custom={project.customCover()}
                selected={project.cover()}
                onSelect={project.setCover}
                onChooseFile={() => void project.chooseCoverFile()}
              />
              <Show when={error()}>
                {(message) => (
                  <Note tone="error" testid="audio-import-error">
                    {message()}
                  </Note>
                )}
              </Show>
            </>
          )}
        </Match>
      </Switch>
    ),
  };
}

/**
 * A new project from an audio file the user has, stage by stage: the song (its details, cover and language; Next
 * copies the file as it is and separates the voice), the lyrics, the chart, and a summary whose "Create project" asks
 * where to save and writes the project. Until then everything lives in a draft that is thrown away when the dialog
 * closes.
 */
export function AudioFlow(props: {
  /** The file's place on disk (main has allowed it). */
  path: string;
  /** What the start screen knew about it before it is read. */
  file: AudioFileSummary;
  /** False once the dialog closes. */
  open: boolean;
  header: (stage: number) => JSX.Element;
  onOpened: (project: OpenedProject) => void;
  /** Whether the dialog may close now: not while the project is saved. */
  onLockedChange?: (locked: boolean) => void;
}) {
  const project = createNewProject();
  const [reading, setReading] = createSignal<Reading>({ status: "tools" });

  const read = async () => {
    setReading({ status: "reading" });
    try {
      const details = await native.audio.inspect({ path: props.path });
      project.setBasis({
        artist: details.artist,
        title: details.title,
        duration: details.duration,
        year: details.year,
        language: null,
        picture: details.artwork !== null,
      });
      setReading({ status: "read", details });
    } catch (failure) {
      setReading({ status: "failed", message: errorMessage(failure) });
    }
  };

  const flow = createFlow([
    audioSongStage(
      project,
      () => props.path,
      reading,
      () => void read(),
    ),
    lyricsStage(project),
    chartStage(project),
    finishStage(project, {
      sourcePicture: "The file's artwork",
      onOpened: (opened) => props.onOpened(opened),
    }),
  ]);
  const details = () => {
    const current = reading();
    return current.status === "read" ? current.details : undefined;
  };

  return (
    <FlowView
      flow={flow}
      open={props.open}
      busy={reading().status === "reading"}
      header={props.header}
      onLockedChange={props.onLockedChange}
      source={<FileCard file={props.file} details={details()} />}
    />
  );
}

/** The file the project is made from: its artwork once read, name, format, size and length. */
function FileCard(props: { file: AudioFileSummary; details: AudioFileDetails | undefined }) {
  return (
    <div
      class="flex items-center gap-3 rounded-[10px] border border-popover-line bg-popover-well/50 p-2.5"
      data-testid="audio-file"
    >
      <Show
        when={props.details?.artwork}
        fallback={
          <span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
            <FileAudioIcon class="size-5" />
          </span>
        }
      >
        {(artwork) => <img src={artwork()} alt="" class="size-10 shrink-0 rounded-lg object-cover" />}
      </Show>
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="truncate text-[12.5px] font-medium text-foreground" data-testid="audio-file-name">
          {props.file.name}
        </span>
        <span class="font-mono text-[10.5px] text-popover-muted">
          {props.file.format || "Audio"} · {formatFileSize(props.file.size)}
          <Show when={props.details?.duration}>{(duration) => <> · {formatDuration(duration())}</>}</Show>
        </span>
      </div>
    </div>
  );
}
