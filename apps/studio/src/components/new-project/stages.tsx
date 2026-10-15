import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";

import { Note } from "~/components/home/song-import-flow";
import { formatFileSize } from "~/lib/format";
import { languageName } from "~/lib/languages";
import { native } from "~/lib/native/client";
import { errorMessage } from "~/lib/native/errors";
import type { ImportProgress, OpenedProject } from "~/lib/native/types";

import { ChartChoice } from "./chart-choice";
import type { Stage } from "./flow-runner";
import { LyricsReview } from "./lyrics-review";
import type { NewProject } from "./new-project";
import { follow, percentOf, progressBarClass } from "./progress";

/** The lyrics the project starts with: found online, heard in the song, or the user's own. */
export function lyricsStage(project: NewProject): Stage {
  return {
    id: "lyrics",
    tag: "Lyrics",
    enter: () => project.searchLyricsIfChanged(),
    canAdvance: () =>
      !(project.lyricsSource() === "found" && project.lyricsSearch().status === "searching") &&
      // Saving removes the draft that listening still reads from.
      project.listening().status !== "listening",
    body: () => (
      <LyricsReview
        search={project.lyricsSearch()}
        listening={project.listening()}
        listeningModelMissing={project.models()?.whisper === false}
        source={project.lyricsSource()}
        ownText={project.ownLyrics()}
        videoDuration={project.basis()?.duration ?? null}
        language={project.chosenLanguage()}
        onSource={project.pickLyricsSource}
        onOwnText={project.editLyrics}
        onRetry={project.retryLyrics}
        onListen={(heard) => void project.listen(heard)}
      />
    ),
  };
}

/** Whether to make the chart now; Next makes it (once for the same lyrics and language) and keeps it in the draft. */
export function chartStage(project: NewProject): Stage {
  const [making, setMaking] = createSignal<ImportProgress | null | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  return {
    id: "chart",
    tag: "Chart",
    enter: () => setError(null),
    canAdvance: () => true,
    run: async (signal) => {
      setError(null);
      const draft = project.draft();
      const language = project.songLanguage();
      const lyrics = project.projectLyrics();
      if (!project.wantsChart() || project.currentChart()) return true;
      if (!draft || !language || !lyrics) return false;
      // Main forgets the chart it had as soon as a new one is started; so does this side.
      project.setMadeChart(null);
      setMaking(null);
      try {
        const made = await follow(
          () => native.drafts.makeChart({ draftId: draft.draftId, lines: lyrics.lines, language }, { signal }),
          signal,
          setMaking,
        );
        if (!made) return false;
        project.setMadeChart(made);
        return true;
      } catch (failure) {
        setError(errorMessage(failure));
        return false;
      } finally {
        setMaking(undefined);
      }
    },
    body: () => (
      <>
        <ChartChoice
          language={project.songLanguage()}
          makeChart={project.makeChart()}
          hasLyrics={project.projectLyrics() !== null}
          modelsMissing={project.models() ? !project.models()!.chart : null}
          made={project.currentChart()}
          making={making()}
          disabled={making() !== undefined}
          onLanguage={project.setLanguage}
          onMakeChart={project.setMakeChart}
        />
        <Show when={error()}>
          {(message) => (
            <Note tone="error" testid="chart-error">
              {message()} You can leave the chart empty and make it later in the project.
            </Note>
          )}
        </Show>
      </>
    ),
  };
}

/** One line of the Finish stage's summary. */
function SummaryRow(props: { label: string; children: JSX.Element; testid: string }) {
  return (
    <li class="flex items-baseline gap-3 py-2 text-[11.5px]" data-testid={props.testid}>
      <span class="w-16 shrink-0 text-[10.5px] text-popover-muted">{props.label}</span>
      <span class="min-w-0 flex-1 text-popover-foreground">{props.children}</span>
    </li>
  );
}

const lineCount = (count: number) => `${count} ${count === 1 ? "line" : "lines"}`;

/** The lyrics in a few words. */
function describeLyrics(project: NewProject): string {
  const lyrics = project.projectLyrics();
  if (!lyrics) return "None. The project starts without lyrics.";
  const from = { lrclib: "from LRCLIB", whisper: "heard in the song", user: "written by you" }[lyrics.source];
  return `${lineCount(lyrics.lines.length)} ${from}`;
}

/** The cover in a few words. */
function describeCover(project: NewProject, sourcePicture: string): string {
  const choice = project.coverChoice();
  if (choice.kind === "none") return "None";
  if (choice.kind === "thumbnail") return sourcePicture;
  if (choice.kind === "file") return "Your image";
  const found = project.covers()?.find((candidate) => candidate.url === choice.url);
  return found?.album ? `The cover of “${found.album}”` : "A cover found online";
}

/** The media in a few words. */
function describeMedia(project: NewProject): string {
  const draft = project.draft();
  if (!draft) return "";
  const parts = [`Audio (${formatFileSize(draft.audio.size)})`];
  if (draft.video) parts.push(`video (${formatFileSize(draft.video.size)})`);
  parts.push("the voice separated from the music");
  return parts.join(", ");
}

/**
 * The last stage: what the project will be made of (Back leads to where each was chosen), and "Create project…",
 * which asks where to save and writes the project.
 */
export function finishStage(
  project: NewProject,
  options: {
    /** What the source's own picture is called ("The video's thumbnail"). */
    sourcePicture: string;
    onOpened: (opened: OpenedProject) => void;
  },
): Stage {
  const [saving, setSaving] = createSignal<ImportProgress | null | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  return {
    id: "finish",
    tag: "Finish",
    primary: "Create project…",
    // Once saving starts, the draft goes into the project: stopping halfway would leave neither.
    stoppable: false,
    enter: () => setError(null),
    canAdvance: () => project.draft() !== null,
    run: async (signal) => {
      setError(null);
      const draft = project.draft();
      if (!draft) return false;
      let target: string | null;
      try {
        target = await native.dialogs.chooseProjectLocation({
          name: `${project.artist().trim()} - ${project.title().trim()}`,
        });
      } catch (failure) {
        setError(errorMessage(failure));
        return false;
      }
      if (!target || signal.aborted) return false;
      setSaving(null);
      try {
        const opened = await follow(
          () =>
            native.drafts.create(
              {
                draftId: draft.draftId,
                artist: project.artist().trim(),
                title: project.title().trim(),
                year: project.songSource()?.year ?? project.basis()?.year ?? null,
                genre: project.songSource()?.genre ?? null,
                cover: project.coverChoice(),
                lyrics: project.projectLyrics(),
                language: project.songLanguage(),
                chart: project.wantsChart() && project.currentChart() ? "made" : "empty",
                target,
              },
              { signal },
            ),
          signal,
          setSaving,
        );
        if (!opened) return false;
        project.markSaved();
        options.onOpened(opened);
        return true;
      } catch (failure) {
        setError(errorMessage(failure));
        return false;
      } finally {
        setSaving(undefined);
      }
    },
    body: () => {
      const language = () => project.songLanguage();
      const chart = () => project.currentChart();
      return (
        <>
          <ul class="m-0 flex list-none flex-col divide-y divide-popover-line p-0" data-testid="finish-summary">
            <SummaryRow label="Song" testid="finish-song">
              {project.artist().trim()} – {project.title().trim()}
              <Show when={language()}>
                {(code) => <span class="text-popover-muted"> · {languageName(code())}</span>}
              </Show>
            </SummaryRow>
            <SummaryRow label="Cover" testid="finish-cover">
              {describeCover(project, options.sourcePicture)}
            </SummaryRow>
            <SummaryRow label="Lyrics" testid="finish-lyrics">
              {describeLyrics(project)}
            </SummaryRow>
            <SummaryRow label="Chart" testid="finish-chart">
              <Show when={project.wantsChart() && chart()} fallback="Empty, to make later in the project">
                {(made) => (
                  <>
                    Made: {made().notes} notes in {lineCount(made().lines)}
                  </>
                )}
              </Show>
            </SummaryRow>
            <SummaryRow label="Media" testid="finish-media">
              {describeMedia(project)}
              <Show when={project.draft()?.videoProblem}>
                {(problem) => <span class="block text-amber-73">No video: {problem()}</span>}
              </Show>
            </SummaryRow>
          </ul>
          <Show when={saving() !== undefined}>
            <div class="flex flex-col gap-2" data-testid="finish-progress">
              <span class="text-[11px] text-popover-foreground" aria-live="polite">
                {saving()?.step ?? "Saving the project"}…
              </span>
              <progress
                aria-label="Saving progress"
                max="100"
                value={percentOf(saving() ?? null)}
                class={progressBarClass}
              />
            </div>
          </Show>
          <Show when={error()}>
            {(message) => (
              <Note tone="error" testid="finish-error">
                {message()}
              </Note>
            )}
          </Show>
        </>
      );
    },
  };
}

/** Stage tags, for a header that lists them. */
export const stageTags = (stages: readonly Stage[]) => stages.map((stage) => stage.tag);
