import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import CheckIcon from "~icons/lucide/check";
import CircleDashedIcon from "~icons/lucide/circle-dashed";
import FileMusicIcon from "~icons/lucide/file-music";
import LoaderCircleIcon from "~icons/lucide/loader-circle";
import TriangleAlertIcon from "~icons/lucide/triangle-alert";

import { Checklist } from "~/components/new-project/checklist";
import { createFlow, FlowView, type Stage } from "~/components/new-project/flow-runner";
import { SummaryRow } from "~/components/new-project/summary";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Note } from "~/components/ui/note";
import { ProgressBar } from "~/components/ui/progress-bar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch as Toggle } from "~/components/ui/switch";
import { formatFileSize } from "~/lib/format";
import { native } from "~/lib/native/client";
import { errorMessage } from "~/lib/native/errors";
import { follow, percentOf } from "~/lib/native/progress";
import type { Progress, MediaRole, ModelStatus, OpenedProject, SongInspection } from "~/lib/native/types";
import { GETTING_SEPARATION_MODEL, SEPARATING_THE_VOICE } from "~/lib/steps";

/** Labels for media roles, in the order the dialog lists them. */
export const ROLE_LABELS: Record<MediaRole, string> = {
  audio: "Audio",
  vocals: "Vocals",
  instrumental: "Instrumental",
  video: "Video",
  cover: "Cover",
  background: "Background",
};

const discard = (id: string) => void native.drafts.discard({ draftId: id }).catch(() => {});

/** The stages an UltraStar import goes through, as the dialog's header lists them. */
export const SONG_STAGES = ["Song", "Finish"];

/** Reading the song folder. */
type Reading =
  | { status: "reading" }
  | { status: "failed"; message: string }
  | { status: "read"; inspection: SongInspection };

/** Whether the folder brings its own vocals and music (nothing to separate). */
const hasStems = (inspection: SongInspection) =>
  ["vocals", "instrumental"].every((role) => inspection.media.some((file) => file.role === role && file.found));

/**
 * Importing an UltraStar song, stage by stage like a new project: the song (what the folder holds, which chart, the
 * video or not; Next separates the voice from its audio unless the folder has vocals and music), and a summary whose
 * "Create project" asks where to save and copies everything in. The folder stays as it is; the separated voice waits
 * in a draft that is thrown away when the dialog closes.
 */
export function SongImportFlow(props: {
  path: string;
  /** False once the dialog closes. */
  open: boolean;
  header: (step: number) => JSX.Element;
  onOpened: (project: OpenedProject) => void;
  /** True once closing would lose work (the voice separated, or separating). */
  onBusyChange?: (busy: boolean) => void;
  /** Whether the dialog may close now: not while the project is saved. */
  onLockedChange?: (locked: boolean) => void;
}) {
  const [reading, setReading] = createSignal<Reading>({ status: "reading" });
  const [includeVideo, setIncludeVideo] = createSignal(true);
  const [models, setModels] = createSignal<ModelStatus | null>(null);
  const [separating, setSeparating] = createSignal<Progress | null | undefined>(undefined);
  const [saving, setSaving] = createSignal<Progress | null | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  const [draftId, setDraftId] = createSignal<string | null>(null);
  let saved = false;
  let disposed = false;
  /** Counts readings, so an answer for a chart chosen before another is dropped. */
  let readings = 0;
  /**
   * The separated voice is in a draft now; one that arrives after the dialog went away, or for a chart read before
   * the one chosen now (`reading`), is thrown away.
   */
  const keepDraft = (id: string, reading: number) => {
    if (disposed || reading !== readings) discard(id);
    else setDraftId(id);
  };

  const inspection = () => {
    const current = reading();
    return current.status === "read" ? current.inspection : undefined;
  };
  const inspect = async (chart?: string) => {
    const reading = ++readings;
    // The voice separated from another chart's audio isn't this one's.
    const id = draftId();
    if (id) {
      discard(id);
      setDraftId(null);
    }
    setReading({ status: "reading" });
    try {
      const found = await native.song.inspect({ path: props.path, ...(chart ? { chart } : {}) });
      if (reading !== readings) return;
      setIncludeVideo(found.media.some((file) => file.role === "video" && file.found));
      setReading({ status: "read", inspection: found });
    } catch (failure) {
      if (reading === readings) setReading({ status: "failed", message: errorMessage(failure) });
    }
  };
  onSettled(() => {
    void inspect();
    return () => {
      disposed = true;
      const id = draftId();
      if (id && !saved) discard(id);
    };
  });
  createEffect(
    () => draftId() !== null || separating() !== undefined,
    (busy) => {
      props.onBusyChange?.(busy);
    },
  );

  const songStage: Stage = {
    id: "song",
    tag: "Song",
    canAdvance: () => Boolean(inspection() && !inspection()!.blocker),
    run: async (signal) => {
      setError(null);
      const found = inspection();
      if (!found || hasStems(found) || draftId()) return true;
      const reading = readings;
      setModels(await native.models.status().catch(() => null));
      setSeparating(null);
      try {
        const separated = await follow(
          () => native.song.separate({ path: props.path, chart: found.chart }, { signal }),
          signal,
          setSeparating,
          (late) => keepDraft(late.draftId, reading),
        );
        if (!separated) return false;
        keepDraft(separated.draftId, reading);
        return true;
      } catch (failure) {
        setError(errorMessage(failure));
        return false;
      } finally {
        setSeparating(undefined);
      }
    },
    body: () => (
      <Switch>
        <Match when={reading().status === "reading"}>
          <p class="m-0 flex items-center gap-2 text-[11.5px] text-popover-foreground" aria-live="polite">
            <LoaderCircleIcon class="size-4 animate-spin text-primary" />
            Reading the song…
          </p>
        </Match>
        <Match when={reading().status === "failed" ? (reading() as { message: string }) : undefined}>
          {(failed) => (
            <Note tone="error" testid="song-import-error">
              <span class="flex items-center gap-3">
                <span class="flex-1">{failed().message}</span>
                <Button variant="outline" size="xs" onClick={() => void inspect()}>
                  Try again
                </Button>
              </span>
            </Note>
          )}
        </Match>
        <Match when={separating() !== undefined}>
          <Checklist
            title="Separating the voice"
            hint="This takes a minute or two."
            label="Separating"
            testid="song-separating"
            tasks={[...(models() && !models()!.separation ? [GETTING_SEPARATION_MODEL] : []), SEPARATING_THE_VOICE]}
            progress={separating() ?? null}
          />
        </Match>
        <Match when={inspection()}>
          {(found) => (
            <>
              <SongSummary
                inspection={found()}
                includeVideo={includeVideo()}
                locked={false}
                onIncludeVideo={setIncludeVideo}
                onChart={(chart) => void inspect(chart)}
              />
              <Show when={error()}>
                {(message) => (
                  <Note tone="error" testid="song-separate-error">
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

  const finishStage: Stage = {
    id: "finish",
    tag: "Finish",
    primary: "Create project",
    // Once saving starts, the files go into the project: stopping halfway would leave neither.
    stoppable: false,
    enter: () => setError(null),
    canAdvance: () => inspection() !== undefined,
    run: async (signal) => {
      setError(null);
      const found = inspection();
      if (!found) return false;
      let target: string | null;
      try {
        target = await native.dialogs.chooseProjectLocation({ name: found.suggestedName });
      } catch (failure) {
        setError(errorMessage(failure));
        return false;
      }
      if (!target || signal.aborted) return false;
      setSaving(null);
      try {
        const opened = await follow(
          () =>
            native.song.import(
              {
                path: props.path,
                chart: found.chart,
                includeVideo: includeVideo(),
                target,
                ...(draftId() ? { draftId: draftId()! } : {}),
              },
              { signal },
            ),
          signal,
          setSaving,
        );
        if (!opened) return false;
        saved = true;
        props.onOpened(opened);
        return true;
      } catch (failure) {
        setError(errorMessage(failure));
        return false;
      } finally {
        setSaving(undefined);
      }
    },
    body: () => (
      <Show when={inspection()}>
        {(found) => (
          <>
            <ul class="m-0 flex list-none flex-col divide-y divide-popover-line p-0" data-testid="song-summary">
              <SummaryRow label="Song" testid="summary-song">
                {found().artist || "Unknown artist"} – {found().title || "Untitled"}
              </SummaryRow>
              <SummaryRow label="Chart" testid="summary-chart">
                {found().notes} {found().notes === 1 ? "note" : "notes"} from {found().chart}
              </SummaryRow>
              <SummaryRow label="Vocals" testid="summary-vocals">
                {hasStems(found()) ? "The song's own vocals and music" : "Separated from the song"}
              </SummaryRow>
              <SummaryRow label="Video" testid="summary-video">
                {found().media.some((file) => file.role === "video" && file.found)
                  ? includeVideo()
                    ? "Included"
                    : "Left out"
                  : "None"}
              </SummaryRow>
            </ul>
            <Show when={saving() !== undefined}>
              <ImportProgressBar progress={saving() ?? null} />
            </Show>
            <Show when={error()}>
              {(message) => (
                <Note tone="error" testid="song-import-error">
                  {message()}
                </Note>
              )}
            </Show>
          </>
        )}
      </Show>
    ),
  };

  const flow = createFlow([songStage, finishStage]);
  return (
    <FlowView
      flow={flow}
      open={props.open}
      busy={reading().status === "reading"}
      header={props.header}
      onLockedChange={props.onLockedChange}
    />
  );
}

function SongSummary(props: {
  inspection: SongInspection;
  includeVideo: boolean;
  locked: boolean;
  onIncludeVideo: (value: boolean) => void;
  onChart: (chart: string) => void;
}) {
  const video = () => props.inspection.media.find((file) => file.role === "video" && file.found);
  const details = () =>
    [
      `${props.inspection.notes} ${props.inspection.notes === 1 ? "note" : "notes"}`,
      props.inspection.singers > 1 ? `Duet` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <>
      <div class="flex items-center gap-3 rounded-[10px] border border-popover-line bg-popover-well/50 p-3">
        <span class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-soft text-violet">
          <FileMusicIcon class="size-5" />
        </span>
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="truncate text-[12.5px] font-medium text-foreground" data-testid="song-title">
            {props.inspection.artist || "Unknown artist"} · {props.inspection.title || "Untitled"}
          </span>
          <span class="truncate font-mono text-[10.5px] text-popover-muted" title={props.inspection.folder}>
            {details()} · {props.inspection.chart}
          </span>
        </div>
      </div>

      <Show when={props.inspection.charts.length > 1}>
        <div class="flex flex-col gap-1.5">
          <span id="song-chart" class="text-[10px] leading-none text-sage-68">
            Chart
          </span>
          <Select
            value={props.inspection.chart}
            disabled={props.locked}
            onValueChange={(value: unknown) => {
              if (typeof value === "string" && value !== props.inspection.chart) props.onChart(value);
            }}
          >
            <SelectTrigger class="w-full" aria-labelledby="song-chart">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <For each={props.inspection.charts}>{(chart) => <SelectItem value={chart}>{chart}</SelectItem>}</For>
            </SelectContent>
          </Select>
        </div>
      </Show>

      <ul
        aria-label="Song files"
        class="m-0 flex list-none flex-col divide-y divide-popover-line overflow-hidden rounded-[10px] border border-popover-line bg-popover-well/50 p-0"
      >
        <li class="flex items-center gap-3 px-3 py-2.5 text-[11.5px]">
          <CheckIcon class="size-4 text-primary" stroke-width={2.2} />
          <span class="w-[88px] text-popover-muted">Chart</span>
          <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-popover-foreground">
            {props.inspection.chart}
          </span>
        </li>
        <For each={props.inspection.media}>
          {(file) => (
            <li class="flex items-center gap-3 px-3 py-2.5 text-[11.5px]" data-testid="song-file">
              <Show
                when={file.found}
                fallback={
                  file.role === "audio" ? (
                    <TriangleAlertIcon class="size-4 text-destructive" />
                  ) : (
                    <CircleDashedIcon class="size-4 text-faint-foreground" />
                  )
                }
              >
                <CheckIcon class="size-4 text-primary" stroke-width={2.2} />
              </Show>
              <span class="w-[88px] text-popover-muted">{ROLE_LABELS[file.role]}</span>
              <span
                class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-popover-foreground"
                title={file.fileName}
              >
                {file.fileName}
              </span>
              <span class="shrink-0 font-mono text-[10.5px] text-popover-muted">
                {file.found && file.size !== undefined ? formatFileSize(file.size) : "Missing"}
              </span>
            </li>
          )}
        </For>
      </ul>

      <Show when={video()}>
        {(file) => (
          <div class="flex items-center justify-between gap-3 rounded-lg border border-input bg-field px-3 py-2">
            <div class="flex flex-col gap-0.5">
              <Label for="include-video">Include video</Label>
              <span class="text-[10.5px] text-popover-muted">
                Adds {formatFileSize(file().size ?? 0)} to the project. Leave it out to keep the file small.
              </span>
            </div>
            <Toggle
              id="include-video"
              size="sm"
              checked={props.includeVideo}
              disabled={props.locked}
              onCheckedChange={(checked: boolean) => props.onIncludeVideo(checked)}
              data-testid="include-video"
            />
          </div>
        )}
      </Show>

      <Show when={props.inspection.blocker}>
        {(blocker) => (
          <Note tone="error" testid="song-blocker">
            {blocker()}
          </Note>
        )}
      </Show>
      <Show when={props.inspection.warnings.length > 0}>
        <Note tone="warning" testid="song-warnings">
          <ul class="m-0 flex list-none flex-col gap-1 p-0">
            <For each={props.inspection.warnings}>{(warning) => <li>{warning}</li>}</For>
          </ul>
        </Note>
      </Show>
    </>
  );
}

function ImportProgressBar(props: { progress: Progress | null }) {
  const percent = () => percentOf(props.progress) ?? 0;
  return (
    <div class="flex flex-col gap-2" data-testid="song-import-progress">
      <div class="flex items-center justify-between text-[11px]">
        <span class="truncate text-popover-foreground" aria-live="polite">
          {props.progress?.step ?? "Creating the project…"}
        </span>
        <span class="font-mono text-[10.5px] text-popover-muted tabular-nums">{percent()}%</span>
      </div>
      <ProgressBar label="Import progress" value={percent()} />
    </div>
  );
}
