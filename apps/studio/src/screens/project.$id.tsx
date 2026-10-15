import { getRouteApi, useNavigate, useRouter } from "@tanstack/solid-router";
import { createMemo, createSignal, onSettled, Show } from "solid-js";
import DownloadIcon from "~icons/lucide/download";
import LoaderCircleIcon from "~icons/lucide/loader-circle";
import PanelRightIcon from "~icons/lucide/panel-right";
import XIcon from "~icons/lucide/x";

import { BreakLane, LyricsLane, OverviewBar, TimeRuler } from "~/components/editor/lanes";
import { GUTTER_PX, PianoRoll } from "~/components/editor/piano-roll";
import { Playhead } from "~/components/editor/playhead";
import { SongPanel } from "~/components/editor/song-panel";
import { Transport } from "~/components/editor/transport";
import { ReplaceExportDialog } from "~/components/project/replace-export-dialog";
import { TitleBar } from "~/components/title-bar";
import { Button } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";
import { revealLabel } from "~/lib/desktop";
import { chartEnd, drawnNotes, lineBreaks, lineIndexAt, lineSpans, longest, stepLine } from "~/lib/editor/chart";
import { createPlayback } from "~/lib/editor/playback";
import {
  clampView,
  fitRange,
  follow,
  pitchRange,
  scrollBy,
  type TimeView,
  visibleItems,
  visibleSeconds,
  zoomAt,
} from "~/lib/editor/view";
import { native } from "~/lib/native/client";
import { errorMessage } from "~/lib/native/errors";

const route = getRouteApi("/project/$id");

function reveal(path: string) {
  native.files.reveal({ path }).catch((error: unknown) => {
    toast.add({ type: "error", title: "Couldn't show it", description: errorMessage(error) });
  });
}

/** A field, text area or editable element has the keyboard: the editor's keys leave it alone. */
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
      !!target.closest("[role=dialog]"))
  );
}

/** How much of the song the view shows at first. */
const FIRST_VIEW_SECONDS = 12;

/**
 * An open project: the chart editor. The editing area shows the song at a glance (overview), the notes against time
 * and pitch, and each line's text, with playback of the song, its vocals or its music. Everything else about the song
 * (details, media, lyrics, making the chart) is in the Song panel. Read-only so far.
 */
export default function ProjectScreen() {
  const data = route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const overview = () => data().overview;
  const [exporting, setExporting] = createSignal(false);
  const [replacing, setReplacing] = createSignal<{ folder: string; existing: string } | null>(null);

  const notes = createMemo(() => drawnNotes(data().chart));
  const lines = createMemo(() => lineSpans(data().chart));
  const range = createMemo(() => pitchRange(notes().map((note) => note.pitch)));
  const longestNote = createMemo(() => longest(notes()));
  const longestLine = createMemo(() => longest(lines()));
  const duet = () => data().chart.singers.length > 1;
  const breaks = createMemo(() => lineBreaks(data().chart));
  const [songPanel, setSongPanel] = createSignal(notes().length === 0);

  const media = (role: string) => overview().media.find((item) => item.role === role)?.url;
  const [view, setView] = createSignal<TimeView>({ start: 0, pxPerSecond: 80 });
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  /** The user scrolled while playing: the view stops following the playhead until playback starts again. */
  let scrolledAway = false;
  let placed = false;
  const width = () => size().width;
  const length = () => Math.max(playback.duration(), chartEnd(notes()) + 1, 1);

  const playback = createPlayback(
    { audio: media("audio"), vocals: media("vocals"), instrumental: media("instrumental") },
    (time) => {
      if (!scrolledAway && width() > 0) setView((current) => follow(current, time, width(), length()));
    },
  );

  const visibleNotes = createMemo(() =>
    visibleItems(notes(), view().start, view().start + visibleSeconds(view(), width()), longestNote()),
  );
  const visibleBreaks = createMemo(() => {
    const from = view().start;
    const to = from + visibleSeconds(view(), width());
    return breaks().filter((item) => item.time >= from && item.time <= to);
  });
  const visibleLines = createMemo(() =>
    visibleItems(lines(), view().start, view().start + visibleSeconds(view(), width()), longestLine()),
  );

  const seek = (seconds: number) => {
    scrolledAway = false;
    playback.seek(Math.min(length(), Math.max(0, seconds)));
  };
  const changeView = (next: TimeView) => {
    if (playback.playing()) scrolledAway = true;
    setView(clampView(next, width(), length()));
  };
  /** Moves the playhead to a line and brings it on screen, fitting it when it doesn't fit. */
  const goToLine = (line: { start: number; duration: number } | undefined, fit = false) => {
    if (!line) return;
    seek(line.start);
    const current = view();
    const fits = line.duration < visibleSeconds(current, width()) * 0.9;
    const onScreen =
      line.start >= current.start && line.start + line.duration <= current.start + visibleSeconds(current, width());
    if (fit || !fits) setView(fitRange(line.start, line.start + line.duration, width(), length()));
    else if (!onScreen)
      setView(clampView({ ...current, start: line.start - visibleSeconds(current, width()) * 0.1 }, width(), length()));
  };

  let editArea: HTMLDivElement | undefined;
  let rollArea: HTMLDivElement | undefined;

  onSettled(() => {
    playback.load();
    const observer = new ResizeObserver(() => {
      if (!rollArea) return;
      const next = { width: Math.max(0, rollArea.clientWidth - GUTTER_PX), height: rollArea.clientHeight };
      setSize(next);
      if (!placed && next.width > 0) {
        placed = true;
        const first = lines()[0];
        const start = first ? Math.max(0, first.start - 1) : 0;
        setView(fitRange(start, start + FIRST_VIEW_SECONDS, next.width, length(), 0));
      } else {
        setView((current) => clampView(current, next.width, length()));
      }
    });
    if (rollArea) observer.observe(rollArea);

    // Cmd/Ctrl+wheel and pinch (which comes as Ctrl+wheel) zoom at the pointer; other wheel scrolls through time.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const x = event.clientX - (editArea?.getBoundingClientRect().left ?? 0) - GUTTER_PX;
      if (event.ctrlKey || event.metaKey) {
        changeView(zoomAt(view(), Math.exp(-event.deltaY * 0.01), x, width(), length()));
      } else {
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        changeView(scrollBy(view(), delta, width(), length()));
      }
    };
    editArea?.addEventListener("wheel", onWheel, { passive: false });

    const onKey = (event: KeyboardEvent) => {
      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === " ") {
        event.preventDefault();
        if (!playback.playing()) scrolledAway = false;
        playback.toggle();
      } else if (event.key === "." || event.key === ",") {
        event.preventDefault();
        goToLine(stepLine(lines(), playback.time(), event.key === "." ? 1 : -1));
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        goToLine(lines()[lineIndexAt(lines(), playback.time())], true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      editArea?.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      playback.dispose();
    };
  });

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
        <div class="mr-auto flex max-w-[420px] min-w-0 items-baseline gap-1.5 text-[12.5px]">
          <h1 class="m-0 truncate text-[12.5px] font-medium text-foreground">{overview().song.title || "Untitled"}</h1>
          <span class="truncate text-muted-foreground">· {overview().song.artist || "Unknown artist"}</span>
        </div>
        <Button
          variant={songPanel() ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={songPanel() ? "true" : "false"}
          onClick={() => void setSongPanel(!songPanel())}
          data-testid="song-panel-toggle"
        >
          <PanelRightIcon />
          Song
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void chooseExport()}
          disabled={exporting()}
          data-testid="export-song"
        >
          <Show when={exporting()} fallback={<DownloadIcon />}>
            <LoaderCircleIcon class="animate-spin" />
          </Show>
          Export…
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void close()} data-testid="close-project">
          <XIcon />
          Close
        </Button>
      </TitleBar>
      <div class="flex min-h-0 flex-1">
        <div ref={(element) => (editArea = element)} class="flex min-w-0 flex-1 flex-col" data-testid="editor">
          <OverviewBar
            lines={lines()}
            length={length()}
            view={view()}
            width={width()}
            playhead={playback.time()}
            duet={duet()}
            onScrollTo={(seconds) => changeView({ ...view(), start: seconds - visibleSeconds(view(), width()) / 2 })}
          />
          <div class="relative flex min-h-0 flex-1 flex-col">
            <TimeRuler view={view()} width={width()} onSeek={seek} />
            <BreakLane breaks={visibleBreaks()} view={view()} />
            <div ref={(element) => (rollArea = element)} class="flex min-h-0 flex-1">
              <PianoRoll
                notes={visibleNotes()}
                breaks={visibleBreaks()}
                range={range()}
                view={view()}
                width={width()}
                height={size().height}
                onSeek={seek}
              />
            </div>
            <LyricsLane lines={visibleLines()} all={lines()} view={view()} duet={duet()} />
            <Playhead view={view()} width={width()} time={playback.time()} onScrub={seek} />
          </div>
          <Show when={notes().length === 0}>
            <p
              class="m-0 border-b border-border px-4 py-2 text-[11.5px] text-muted-foreground"
              data-testid="editor-empty"
            >
              The chart is empty. Make it from the vocals and lyrics in the Song panel.
            </p>
          </Show>
        </div>
        <Show when={songPanel()}>
          <SongPanel
            overview={overview()}
            onReveal={() => reveal(overview().path)}
            onChartMade={() => void router.invalidate()}
          />
        </Show>
      </div>
      <Transport
        playback={playback}
        length={length()}
        onZoom={(factor) => changeView(zoomAt(view(), factor, width() / 2, width(), length()))}
      />

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
