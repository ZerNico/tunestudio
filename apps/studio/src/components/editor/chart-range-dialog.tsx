import { createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";

import { percentOf, progressBarClass } from "~/components/new-project/progress";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { lyricLines, rangeProblem, type TimeRange } from "~/lib/chart-range";
import { rangeScope } from "~/lib/editor/chart-range";
import type { ChartRangeJob } from "~/lib/editor/chart-range-job";
import { formatTime } from "~/lib/editor/view";
import type { EditorChart } from "~/lib/native/types";

/** Reviews the whole-note replacement scope before charting the supplied lyric lines. */
export function ChartRangeDialog(props: {
  chart: EditorChart;
  project: string;
  range: TimeRange;
  singerId: number;
  duration: number;
  job: ChartRangeJob;
  onClose: () => void;
}) {
  const [singer, setSinger] = createSignal(untrack(() => props.singerId));
  const [language, setLanguage] = createSignal<"en" | "de">(
    untrack(() => (props.chart.song.language[0]?.toLowerCase() === "german" ? "de" : "en")),
  );
  const scope = createMemo(() => rangeScope(props.chart, singer(), props.range, props.duration));
  const [text, setText] = createSignal(untrack(() => scope()?.text ?? ""));
  let edited = false;
  const [typed, setTyped] = createSignal(false);
  const lines = () => lyricLines(text());
  const problem = () => {
    const range = scope();
    if (!range) return "Select a time range first.";
    if (props.duration <= 0 || range.end > props.duration + 1e-6) return "Choose a range inside the vocals.";
    return rangeProblem(range, lines());
  };
  const close = () => {
    props.job.stop();
    props.onClose();
  };
  onSettled(() => () => props.job.stop());
  const run = () => {
    const range = scope();
    if (!range || problem()) return;
    void props.job.run({
      id: props.project,
      singerId: singer(),
      start: range.start,
      end: range.end,
      lines: lines(),
      language: language(),
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) close();
      }}
    >
      <DialogContent class="w-[min(540px,calc(100vw-32px))]" data-testid="chart-range-dialog">
        <DialogHeader>
          <DialogTitle>Chart range from lyrics</DialogTitle>
          <DialogDescription>
            Enter only the words sung in this passage. Each row becomes a lyric line.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div class="flex items-center gap-3">
            <Show when={props.chart.singers.length > 1}>
              <Select
                value={singer()}
                disabled={props.job.busy()}
                onValueChange={(value: unknown) => {
                  if (typeof value !== "number") return;
                  setSinger(value);
                  props.job.clearError();
                  if (!edited) setText(rangeScope(props.chart, value, props.range, props.duration)?.text ?? "");
                }}
              >
                <SelectTrigger size="sm" aria-label="Singer">
                  <SelectValue>
                    {(value: () => unknown) => {
                      const chosen = () => props.chart.singers.find((item) => item.id === value());
                      return <>{chosen()?.name || `P${chosen()?.index ?? 1}`}</>;
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <For each={props.chart.singers}>
                    {(item) => <SelectItem value={item.id}>{item.name || `P${item.index}`}</SelectItem>}
                  </For>
                </SelectContent>
              </Select>
            </Show>
            <Select
              value={language()}
              disabled={props.job.busy()}
              onValueChange={(value: unknown) => {
                if (value === "en" || value === "de") {
                  setLanguage(value);
                  props.job.clearError();
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Lyrics language">
                <SelectValue>{(value: () => unknown) => <>{value() === "de" ? "German" : "English"}</>}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="de">German</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p class="m-0 text-xs text-popover-muted" data-testid="chart-range-scope">
            {formatTime(scope()?.start ?? 0)} to {formatTime(scope()?.end ?? 0)} · {scope()?.count ?? 0}{" "}
            {scope()?.count === 1 ? "note" : "notes"} replaced
          </p>
          <Label layout="stacked">
            Lyrics
            <Textarea
              id="range-lyrics"
              class="max-h-72 min-h-40"
              value={text()}
              disabled={props.job.busy()}
              onInput={(event) => {
                edited = true;
                setTyped(true);
                props.job.clearError();
                setText(event.currentTarget.value);
              }}
            />
          </Label>
          <Show when={props.job.busy()}>
            <output class="block space-y-2">
              <p class="m-0 text-xs text-popover-foreground">{props.job.progress()?.step ?? "Preparing the range…"}</p>
              <progress
                aria-label="Chart range progress"
                max="100"
                value={percentOf(props.job.progress() ?? null)}
                class={progressBarClass}
              />
            </output>
          </Show>
          <Show when={!props.job.busy() && (props.job.error() || problem())}>
            {/* Said out loud once it's news: after typing, or when charting failed; not as the dialog opens. */}
            <p role={typed() || props.job.error() ? "alert" : undefined} class="m-0 text-xs text-destructive">
              {props.job.error() || problem()}
            </p>
          </Show>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Show
            when={props.job.busy()}
            fallback={
              <Button disabled={!!problem()} onClick={run}>
                Chart range
              </Button>
            }
          >
            <Button onClick={() => props.job.stop()}>Stop</Button>
          </Show>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
