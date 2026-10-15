import { createSignal, Match, onSettled, Switch } from "solid-js";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { Button } from "~/components/ui/button";
import { formatFileSize } from "~/lib/format";
import { native } from "~/lib/native/client";
import { errorMessage, isAbort } from "~/lib/native/errors";
import type { ToolName, ToolProgress } from "~/lib/native/types";

import { Note } from "./song-import-flow";

const LABELS: Record<ToolName, string> = { "yt-dlp": "yt-dlp", quickjs: "QuickJS", ffmpeg: "FFmpeg" };

/** What a YouTube project needs: yt-dlp downloads, QuickJS answers YouTube's checks, FFmpeg converts. */
const YOUTUBE_TOOLS: ToolName[] = ["yt-dlp", "quickjs", "ffmpeg"];

type State =
  | { step: "preparing"; progress: ToolProgress | null }
  | { step: "ready" }
  | { step: "failed"; message: string };

/** What the tools are doing, in words, e.g. "Downloading FFmpeg… 15 MB of 60 MB". */
export function describeToolProgress(progress: ToolProgress | null): string {
  if (!progress) return "Checking the download tools…";
  const label = LABELS[progress.tool];
  if (progress.phase === "checking") return `Checking for ${label} updates…`;
  if (progress.phase === "verifying") return `Verifying ${label}…`;
  if (progress.phase === "installing") return `Installing ${label}…`;
  const received = formatFileSize(progress.received ?? 0);
  return progress.total
    ? `Downloading ${label}… ${received} of ${formatFileSize(progress.total)}`
    : `Downloading ${label}… ${received}`;
}

/** A quick update check stays invisible; anything slower than this shows its progress. */
const SHOW_AFTER_MS = 600;

/**
 * Makes sure yt-dlp, QuickJS and FFmpeg are installed and current before a YouTube project
 * starts. The first time they are downloaded (about 100 MB); afterwards this is instant unless
 * an update is due. Shows nothing unless it downloads, takes a while or fails. `onReady` runs
 * once the tools are ready.
 */
export function ToolsStep(props: { onReady?: () => void }) {
  const [state, setState] = createSignal<State>({ step: "preparing", progress: null });
  const [slow, setSlow] = createSignal(false);
  let controller: AbortController | undefined;

  const prepare = async () => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setState({ step: "preparing", progress: null });
    const timer = setTimeout(() => setSlow(true), SHOW_AFTER_MS);
    try {
      const iterator = await native.tools.prepare({ tools: YOUTUBE_TOOLS }, { signal: current.signal });
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        setState({ step: "preparing", progress: next.value });
      }
      setState({ step: "ready" });
      props.onReady?.();
    } catch (error) {
      if (isAbort(error) || current.signal.aborted) return;
      setState({ step: "failed", message: errorMessage(error) });
    } finally {
      clearTimeout(timer);
    }
  };

  onSettled(() => {
    void prepare();
    return () => controller?.abort();
  });

  const visiblePreparing = () => {
    const value = state();
    if (value.step !== "preparing") return undefined;
    return slow() || (value.progress !== null && value.progress.phase !== "checking") ? value : undefined;
  };

  const percent = () => {
    const value = state();
    if (value.step !== "preparing" || value.progress?.phase !== "downloading" || !value.progress.total)
      return undefined;
    return Math.min(100, Math.round(((value.progress.received ?? 0) / value.progress.total) * 100));
  };

  return (
    <Switch>
      <Match when={visiblePreparing()}>
        {(preparing) => (
          <div class="flex flex-col gap-2" data-testid="tools-progress">
            <p class="m-0 flex items-center gap-2 text-[11.5px] text-popover-foreground" aria-live="polite">
              <LoaderCircleIcon class="size-4 animate-spin text-primary" />
              {describeToolProgress(preparing().progress)}
            </p>
            <progress
              aria-label="Download tools progress"
              max="100"
              value={percent()}
              class="h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-sage-22 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-150"
            />
            <p class="m-0 text-[10.5px] text-popover-muted">
              Tune Studio downloads yt-dlp, QuickJS and FFmpeg once and keeps them up to date.
            </p>
          </div>
        )}
      </Match>
      <Match when={state().step === "failed" ? (state() as Extract<State, { step: "failed" }>).message : undefined}>
        {(message) => (
          <Note tone="error" testid="tools-error">
            <p class="m-0">{message()}</p>
            <Button variant="outline" size="xs" class="mt-2" onClick={() => void prepare()}>
              Try again
            </Button>
          </Note>
        )}
      </Match>
    </Switch>
  );
}
