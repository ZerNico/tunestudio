import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import AudioLinesIcon from "~icons/lucide/audio-lines";
import FolderOpenIcon from "~icons/lucide/folder-open";
import YoutubeIcon from "~icons/lucide/youtube";

import { AUDIO_STAGES, AudioFlow } from "~/components/new-project/audio-flow";
import { YOUTUBE_STAGES, YoutubeFlow } from "~/components/new-project/youtube-flow";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import type { AudioFileSummary } from "~/lib/import-files";
import type { OpenedProject } from "~/lib/native/types";

import { SongImportFlow } from "./song-import-flow";

/** The next step of a "start a new project" option, opened from the start screen. */
export type Flow =
  | { kind: "youtube"; url: string; videoId: string }
  /** An audio file the user picked or dropped (main has allowed its path). */
  | { kind: "audio"; path: string; file: AudioFileSummary }
  /** A song folder or `.txt` chart the user picked or dropped (main has allowed its path). */
  | { kind: "song"; path: string };

const STEPS: Record<Flow["kind"], string[]> = {
  youtube: YOUTUBE_STAGES,
  audio: AUDIO_STAGES,
  song: ["Check song", "Choose location", "Copy into project"],
};

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
  const audioFlows = createMemo(() => {
    const flow = ofKind("audio");
    return flow ? [flow] : [];
  });

  const [songBusy, setSongBusy] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  /** A project is being saved: the dialog stays open until it's done (stopping would leave neither draft nor file). */
  const [locked, setLocked] = createSignal(false);
  // A new flow (or none) starts unlocked, even if the last one went away while saving.
  createEffect(
    () => props.flow,
    () => {
      setLocked(false);
    },
  );
  // A YouTube or audio project is set up as soon as its dialog opens; an UltraStar import only
  // once it saves or copies.
  const guarded = () => (shown()?.kind === "song" ? songBusy() : props.flow !== null);

  return (
    <Dialog
      open={props.flow !== null}
      disablePointerDismissal
      onOpenChange={(open: boolean, details: { cancel: () => void }) => {
        if (open) return;
        if (locked()) {
          details.cancel();
          return;
        }
        if (guarded()) {
          details.cancel();
          setConfirming(true);
          return;
        }
        props.onClose();
      }}
    >
      <DialogContent class="w-[min(560px,calc(100vw-32px))]" showCloseButton={!locked()} data-testid="flow-dialog">
        <Switch>
          <Match when={ofKind("youtube")}>
            <For each={youtubeFlows()}>
              {(flow) => (
                <YoutubeFlow
                  url={flow.url}
                  videoId={flow.videoId}
                  open={props.flow !== null}
                  onOpened={props.onOpened}
                  onLockedChange={setLocked}
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
          <Match when={ofKind("audio")}>
            <For each={audioFlows()}>
              {(flow) => (
                <AudioFlow
                  path={flow.path}
                  file={flow.file}
                  open={props.flow !== null}
                  onOpened={props.onOpened}
                  onLockedChange={setLocked}
                  header={(step) => (
                    <FlowHeader
                      kind="audio"
                      icon={<AudioLinesIcon />}
                      title="New project from audio"
                      description="Check the song and its lyrics, and let Tune Studio separate the voice and make the chart."
                      current={step}
                    />
                  )}
                />
              )}
            </For>
          </Match>
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
