import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import AudioLinesIcon from "~icons/lucide/audio-lines";
import ConstructionIcon from "~icons/lucide/construction";
import FileAudioIcon from "~icons/lucide/file-audio";
import FolderOpenIcon from "~icons/lucide/folder-open";
import YoutubeIcon from "~icons/lucide/youtube";

import { YOUTUBE_STAGES, YoutubeFlow } from "~/components/new-project/youtube-flow";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch as Toggle } from "~/components/ui/switch";
import { formatFileSize } from "~/lib/format";
import type { AudioFileSummary } from "~/lib/import-files";
import type { OpenedProject } from "~/lib/native/types";

import { SongImportFlow } from "./song-import-flow";

/** The next step of a "start a new project" option, opened from the start screen. */
export type Flow =
  | { kind: "youtube"; url: string; videoId: string }
  | { kind: "audio"; file: AudioFileSummary }
  /** A song folder or `.txt` chart the user picked or dropped (main has allowed its path). */
  | { kind: "song"; path: string };

const STEPS: Record<Flow["kind"], string[]> = {
  youtube: YOUTUBE_STAGES,
  audio: ["Import audio", "Split vocals", "Generate chart", "Edit"],
  song: ["Check song", "Choose location", "Copy into project"],
};

const LANGUAGES = ["English", "German", "French", "Spanish", "Italian", "Japanese", "Other"];

const DISCARD_TEXT: Record<Flow["kind"], string> = {
  youtube: "The link and anything fetched so far are lost.",
  audio: "The chosen file stays where it is, but the project setup is lost.",
  song: "The import stops and no project file is saved. The song folder stays as it is.",
};

/**
 * Shows the dialog for `flow`, or nothing while it is `null`. Clicking outside never closes it;
 * Escape, the close button and Cancel ask first while closing would lose the user's progress.
 */
export function FlowDialog(props: {
  flow: Flow | null;
  onClose: () => void;
  /** A flow created and opened a project. */
  onOpened: (project: OpenedProject) => void;
}) {
  // Keeps the last flow while the dialog animates out.
  const shown = createMemo<Flow | null>((previous) => props.flow ?? previous ?? null);
  const ofKind = <K extends Flow["kind"]>(kind: K) => {
    const flow = shown();
    return flow?.kind === kind ? (flow as Extract<Flow, { kind: K }>) : undefined;
  };
  // A list of one, so each new song flow gets a fresh component (For is keyed by item).
  const songFlows = createMemo(() => {
    const flow = ofKind("song");
    return flow ? [flow] : [];
  });
  const youtubeFlows = createMemo(() => {
    const flow = ofKind("youtube");
    return flow ? [flow] : [];
  });

  const [songBusy, setSongBusy] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  // A YouTube or audio project is set up as soon as its dialog opens; an UltraStar import only
  // once it saves or copies.
  const guarded = () => (shown()?.kind === "song" ? songBusy() : props.flow !== null);

  return (
    <Dialog
      open={props.flow !== null}
      disablePointerDismissal
      onOpenChange={(open: boolean, details: { cancel: () => void }) => {
        if (open) return;
        if (guarded()) {
          details.cancel();
          setConfirming(true);
          return;
        }
        props.onClose();
      }}
    >
      <DialogContent class="w-[min(560px,calc(100vw-32px))]" data-testid="flow-dialog">
        <Switch>
          <Match when={ofKind("youtube")}>
            <For each={youtubeFlows()}>
              {(flow) => (
                <YoutubeFlow
                  url={flow.url}
                  videoId={flow.videoId}
                  open={props.flow !== null}
                  onOpened={props.onOpened}
                  header={(step) => (
                    <FlowHeader
                      kind="youtube"
                      icon={<YoutubeIcon />}
                      title="New project from YouTube"
                      description="Check the song and its lyrics, and let Tune Studio download it and make the chart."
                      current={step}
                    />
                  )}
                />
              )}
            </For>
          </Match>
          <Match when={ofKind("audio")}>{(flow) => <AudioFlow file={flow().file} />}</Match>
          <Match when={ofKind("song")}>
            <For each={songFlows()}>
              {(flow) => (
                <SongImportFlow
                  path={flow.path}
                  open={props.flow !== null}
                  onOpened={props.onOpened}
                  onBusyChange={setSongBusy}
                  header={(step) => (
                    <FlowHeader
                      kind="song"
                      icon={<FolderOpenIcon />}
                      title="Import an UltraStar song"
                      description="Tune Studio copies the chart and its media into a new project. The song folder stays as it is."
                      current={step}
                    />
                  )}
                />
              )}
            </For>
          </Match>
        </Switch>
        <Dialog open={confirming()} onOpenChange={setConfirming} disablePointerDismissal>
          <DialogContent class="w-[min(400px,calc(100vw-32px))]" showCloseButton={false} data-testid="discard-dialog">
            <DialogHeader>
              <DialogTitle>Discard this new project?</DialogTitle>
              <DialogDescription>{DISCARD_TEXT[shown()?.kind ?? "youtube"]}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose
                render={(closeProps: JSX.HTMLAttributes<HTMLButtonElement>) => (
                  <Button variant="outline" {...closeProps} />
                )}
              >
                Keep working
              </DialogClose>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirming(false);
                  setSongBusy(false);
                  props.onClose();
                }}
              >
                Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

function FlowHeader(props: {
  kind: Flow["kind"];
  icon: JSX.Element;
  title: string;
  description: string;
  /** The step in progress, from 0. */
  current?: number;
}) {
  return (
    <DialogHeader>
      <div class="flex items-center gap-3">
        <span
          data-kind={props.kind}
          class="flex size-9 items-center justify-center rounded-[9px] border data-[kind=audio]:border-primary-line data-[kind=audio]:bg-primary-soft data-[kind=audio]:text-primary data-[kind=song]:border-violet-line data-[kind=song]:bg-violet-soft data-[kind=song]:text-violet data-[kind=youtube]:border-stone-39 data-[kind=youtube]:bg-youtube-soft data-[kind=youtube]:text-youtube [&>svg]:size-[18px]"
        >
          {props.icon}
        </span>
        <div class="flex flex-col gap-0.5">
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </div>
      </div>
      <ol class="m-0 mt-2 flex list-none items-center gap-1.5 p-0" aria-label="Steps">
        <For each={STEPS[props.kind]}>
          {(step, index) => (
            <li class="flex items-center gap-1.5">
              <Show when={index() > 0}>
                <span aria-hidden="true" class="h-px w-4 bg-popover-line" />
              </Show>
              <span
                data-current={index() === (props.current ?? 0) ? "" : undefined}
                data-done={index() < (props.current ?? 0) ? "" : undefined}
                aria-current={index() === (props.current ?? 0) ? "step" : undefined}
                class="flex items-center gap-1.5 rounded-full border border-popover-line px-2 py-0.5 text-[10px] text-popover-muted data-current:border-primary-line data-current:bg-primary-soft data-current:text-primary-text data-done:text-primary-text"
              >
                <span class="font-mono text-[9px]">{index() + 1}</span>
                {step}
              </span>
            </li>
          )}
        </For>
      </ol>
    </DialogHeader>
  );
}

/** Says plainly that the flow ends here for now. */
function NotImplemented(props: { children: JSX.Element }) {
  return (
    <div
      role="note"
      class="flex gap-3 rounded-[9px] border border-amber-33 bg-warning-soft px-3.5 py-3 text-[11px] leading-[1.6] text-amber-73"
      data-testid="not-implemented"
    >
      <ConstructionIcon class="mt-0.5 size-4 shrink-0 text-warning" />
      <p class="m-0">
        <span class="font-semibold text-warning">Not implemented yet.</span> {props.children}
      </p>
    </div>
  );
}

function FlowFooter(props: { action: string }) {
  return (
    <DialogFooter class="items-center">
      <span class="mr-auto text-[10.5px] text-popover-muted">Preview of the next step</span>
      <DialogClose
        render={(closeProps: JSX.HTMLAttributes<HTMLButtonElement>) => <Button variant="outline" {...closeProps} />}
      >
        Cancel
      </DialogClose>
      <Button disabled>{props.action}</Button>
    </DialogFooter>
  );
}

function AudioFlow(props: { file: AudioFileSummary }) {
  return (
    <>
      <FlowHeader
        kind="audio"
        icon={<AudioLinesIcon />}
        title="New project from audio"
        description="Check the song details, then Tune Studio drafts a chart from the recording."
      />
      <DialogBody>
        <div class="flex items-center gap-3 rounded-[10px] border border-popover-line bg-popover-well/50 p-3">
          <span class="flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary">
            <FileAudioIcon class="size-5" />
          </span>
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="truncate text-[12.5px] font-medium text-foreground" data-testid="audio-file-name">
              {props.file.name}
            </span>
            <span class="font-mono text-[10.5px] text-popover-muted">
              {props.file.format || "Audio"} · {formatFileSize(props.file.size)}
            </span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <Label layout="stacked">
            Artist
            <Input value={props.file.artist} placeholder="Unknown artist" />
          </Label>
          <Label layout="stacked">
            Title
            <Input value={props.file.title} />
          </Label>
        </div>
        <div class="grid grid-cols-2 items-end gap-3">
          <div class="flex flex-col gap-1.5">
            <span id="audio-language" class="text-[10px] leading-none text-sage-68">
              Language
            </span>
            <Select defaultValue="English">
              <SelectTrigger class="w-full" aria-labelledby="audio-language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <For each={LANGUAGES}>{(language) => <SelectItem value={language}>{language}</SelectItem>}</For>
              </SelectContent>
            </Select>
          </div>
          <div class="flex h-7 items-center justify-between rounded-lg border border-input bg-field px-2.5">
            <Label for="split-vocals">Split vocals first</Label>
            <Toggle id="split-vocals" defaultChecked size="sm" />
          </div>
        </div>
        <NotImplemented>Importing and charting audio arrive in a later step. The file wasn't read.</NotImplemented>
      </DialogBody>
      <FlowFooter action="Create project" />
    </>
  );
}
