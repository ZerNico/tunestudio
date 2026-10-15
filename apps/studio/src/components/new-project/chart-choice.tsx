import { Show } from "solid-js";

import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { chartTasks } from "~/lib/chart-steps";
import { CHART_LANGUAGES, languageName } from "~/lib/languages";
import type { ImportProgress, MadeChart } from "~/lib/native/types";

import { Checklist } from "./checklist";
import { LanguageSelect } from "./language-select";

/** Why a chart can't be made for the project, or null when it can. */
export function chartUnavailable(language: string | null, hasLyrics: boolean): string | null {
  if (!hasLyrics)
    return "There are no lyrics to make it from. Go back to add them, or chart the song yourself in the editor.";
  if (language === null) return "Choose the language the song is sung in first.";
  if (!CHART_LANGUAGES.includes(language)) {
    return `Charts can be made in English and German so far, not ${languageName(language)}. The project starts with an empty chart.`;
  }
  return null;
}

/**
 * The Chart stage of a new project: the song's language (the one chosen for the song, changeable here too) and whether
 * the chart is made from the vocals and lyrics now (on Next) or left empty for later, with its progress while it is
 * made.
 */
export function ChartChoice(props: {
  /** ISO 639-1 code, or null when unknown. */
  language: string | null;
  makeChart: boolean;
  /** There are lyrics to make a chart from. */
  hasLyrics: boolean;
  /** The chart models aren't downloaded yet (null: not known). */
  modelsMissing: boolean | null;
  /** The chart made for these lyrics and this language, if it was. */
  made: MadeChart | null;
  /** How far making the chart is, while it is made (null before the first step). */
  making?: ImportProgress | null;
  disabled?: boolean;
  onLanguage: (language: string | null) => void;
  onMakeChart: (make: boolean) => void;
}) {
  const unavailable = () => chartUnavailable(props.language, props.hasLyrics);
  const making = () => props.makeChart && unavailable() === null;
  const describe = () => {
    const reason = unavailable();
    if (reason) return reason;
    if (!making()) return "The project starts with an empty chart. You can make it any time in the project.";
    if (props.made) {
      return `The chart is made: ${props.made.notes} notes in ${props.made.lines} lines. It is a first draft, so check it against the song in the project.`;
    }
    const download = props.modelsMissing ? " The chart models (about 1.6 GB) are downloaded first, once." : "";
    return `Next makes the notes and timing from the vocals and the lyrics. Takes a minute or two.${download}`;
  };
  return (
    <div class="flex flex-col gap-3" data-testid="chart-choice">
      <div class="flex items-center gap-3">
        <span class="text-[11.5px] text-popover-foreground">Sung in</span>
        <LanguageSelect value={props.language} disabled={props.disabled} onChange={props.onLanguage} />
      </div>
      <ToggleGroup
        variant="segment"
        size="segment"
        spacing={0.5}
        aria-label="Chart"
        value={[making() ? "make" : "later"]}
        disabled={props.disabled}
        onValueChange={(value: unknown[]) => {
          if (value[0] === "make" || value[0] === "later") props.onMakeChart(value[0] === "make");
        }}
      >
        <ToggleGroupItem value="make" disabled={unavailable() !== null} data-testid="chart-make">
          Make the chart now
        </ToggleGroupItem>
        <ToggleGroupItem value="later" data-testid="chart-later">
          Leave it empty
        </ToggleGroupItem>
      </ToggleGroup>
      <Show
        when={props.making !== undefined}
        fallback={
          <p
            class="m-0 text-[11px] leading-[1.6] text-popover-muted"
            aria-live="polite"
            data-testid="chart-choice-hint"
          >
            {describe()}
          </p>
        }
      >
        <Checklist
          title="Making the chart"
          hint="This takes a minute or two. Back stops it."
          label="Chart"
          testid="chart-progress"
          tasks={chartTasks(props.modelsMissing === true)}
          progress={props.making ?? null}
        />
      </Show>
    </div>
  );
}
