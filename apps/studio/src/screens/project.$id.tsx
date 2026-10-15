import { getRouteApi, useNavigate, useRouter } from "@tanstack/solid-router";
import { createMemo, createSignal, flush, onSettled, Show } from "solid-js";
import DownloadIcon from "~icons/lucide/download";
import LoaderCircleIcon from "~icons/lucide/loader-circle";
import PanelRightIcon from "~icons/lucide/panel-right";
import Redo2Icon from "~icons/lucide/redo-2";
import Undo2Icon from "~icons/lucide/undo-2";
import XIcon from "~icons/lucide/x";

import { HistoryButton, ToolSwitch } from "~/components/editor/edit-controls";
import { BreakLane, LyricsLane, OverviewBar, TimeRuler } from "~/components/editor/lanes";
import { GUTTER_PX, PianoRoll } from "~/components/editor/piano-roll";
import { Playhead } from "~/components/editor/playhead";
import { SongPanel } from "~/components/editor/song-panel";
import { Transport } from "~/components/editor/transport";
import { follow as followProgress, percentOf, progressBarClass } from "~/components/new-project/progress";
import { ReplaceExportDialog } from "~/components/project/replace-export-dialog";
import { TitleBar } from "~/components/title-bar";
import { Button } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";
import { platform, revealLabel } from "~/lib/desktop";
import { isTyping, runEditCommand, setEditHandler } from "~/lib/edit-commands";
import { createAutoScroll } from "~/lib/editor/autoscroll";
import { createBreakEditing } from "~/lib/editor/break-editing";
import { chartEnd, drawnNotes, lineBreaks, lineIndexAt, lineSpans, longest, stepLine } from "~/lib/editor/chart";
import { createChartDocument } from "~/lib/editor/document";
import { overlapping } from "~/lib/editor/edits";
import { createNoteEditing } from "~/lib/editor/note-editing";
import { createPlayback } from "~/lib/editor/playback";
import { createTools } from "~/lib/editor/tools";
import {
  clampView,
  fitRange,
  follow,
  type PitchRange,
  pitchRange,
  scrollBy,
  type TimeView,
  visibleItems,
  visibleSeconds,
  zoomAt,
} from "~/lib/editor/view";
import type { EditCommand } from "~/lib/native/channel";
import { native } from "~/lib/native/client";
import { errorMessage } from "~/lib/native/errors";
import type { ImportProgress, SungPitch } from "~/lib/native/types";

const route = getRouteApi("/project/$id");

/** Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo (where Undo isn't in a menu). */
function undoKey(event: KeyboardEvent): EditCommand | null {
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}

function reveal(path: string) {
  native.files.reveal({ path }).catch((error: unknown) => {
    toast.add({ type: "error", title: "Couldn't show it", description: errorMessage(error) });
  });
}

/** How much of the song the view shows at first. */
const FIRST_VIEW_SECONDS = 12;

/**
 * An open project: the chart editor. The editing area shows the song at a glance (overview), the notes against time
 * and pitch, and each line's text, with playback of the song, its vocals or its music. Everything else about the song
 * (details, media, lyrics, making the chart) is in the Song panel. Notes are edited with the keys and clicks in
 * `note-editing.ts`.
 */
export default function ProjectScreen() {
  const data = route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const overview = () => data().overview;
  const [exporting, setExporting] = createSignal(false);
  const [replacing, setReplacing] = createSignal<{ folder: string; existing: string } | null>(null);

  /** The selected notes (by id); undo and redo bring back the selection that went with a step. */
  const [selection, setSelection] = createSignal<number[]>([]);
  /**
   * The chart being edited, with its history. Made anew when the project's chart is loaded again (after "Make the
   * chart", or when saving failed), which also starts the history over.
   */
  const doc = createMemo(() =>
    createChartDocument<number[]>({
      chart: data().chart,
      save: async (changes) => {
        await native.project.applyChanges({ id: overview().id, changes });
      },
      onFailed: (error) => {
        toast.add({
          type: "error",
          title: "Couldn't save the last change",
          description: `${errorMessage(error)} The chart was loaded again from the project.`,
        });
        void router.invalidate();
      },
      selection,
      setSelection,
    }),
  );
  const chart = () => doc().chart();
  const notes = createMemo(() => drawnNotes(chart()));
  const lines = createMemo(() => lineSpans(chart()));
  /**
   * The pitch rows: they grow to fit notes moved past them, but don't shrink while editing (the roll would jump); a
   * chart loaded again starts over.
   */
  let shownRange: PitchRange | null = null;
  let rangeFor: unknown = null;
  const range = createMemo(() => {
    if (rangeFor !== doc()) {
      rangeFor = doc();
      shownRange = null;
    }
    const fitted = pitchRange(notes().map((note) => note.pitch));
    shownRange = shownRange
      ? { low: Math.min(shownRange.low, fitted.low), high: Math.max(shownRange.high, fitted.high) }
      : fitted;
    return shownRange;
  });
  const selectedIds = createMemo(() => new Set(selection()));
  const overlaps = createMemo(() => overlapping(chart()));
  const longestNote = createMemo(() => longest(notes()));
  const longestLine = createMemo(() => longest(lines()));
  const duet = () => chart().singers.length > 1;
  const breaks = createMemo(() => lineBreaks(chart()));
  const [songPanel, setSongPanel] = createSignal(notes().length === 0);
  /** What is sung in the vocals (null: none, or not there yet). */
  const [pitch, setPitch] = createSignal<SungPitch | null>(null);
  const [showPitch, setShowPitch] = createSignal(true);
  /** Opening isn't finished: the pitch is being prepared (shown after a moment, with its progress). */
  const [opening, setOpening] = createSignal<ImportProgress | null | undefined>(undefined);

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

  /** Scrolls the view while a drag is at the roll's left or right edge. */
  const autoScroll = createAutoScroll({
    bounds: () => {
      const rect = rollArea?.getBoundingClientRect();
      return rect ? { left: rect.left + GUTTER_PX, right: rect.right } : null;
    },
    scroll: (px) => {
      changeView(scrollBy(view(), px, width(), length()));
      // The drag is redone at once and reads the view.
      flush();
    },
  });
  const breakEditing = createBreakEditing({
    autoScroll,
    viewStart: () => view().start,
    doc,
    singer: () => editing.activeSinger(),
    playheadTime: () => playback.time(),
    onSelect: () => setSelection([]),
    onRefused: (message) => toast.add({ title: message }),
  });
  /** Both gestures: a note drag or drawing, or a break drag. */
  const gestureBusy = () => editing.busy() || breakEditing.busy();
  const cancelGestures = () => {
    editing.cancel();
    breakEditing.cancel();
  };

  const visibleNotes = createMemo(() =>
    visibleItems(notes(), view().start, view().start + visibleSeconds(view(), width()), longestNote()),
  );
  const visibleBreaks = createMemo(() => {
    const from = view().start;
    const to = from + visibleSeconds(view(), width());
    // A break being dragged is drawn where it would go.
    const dragged = breakEditing.drag();
    return breaks()
      .map((item) =>
        dragged?.lineId === item.lineId ? Object.assign({}, item, { time: dragged.time, auto: false }) : item,
      )
      .filter((item) => item.time >= from && item.time <= to);
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

  const editing = createNoteEditing({
    autoScroll,
    viewStart: () => view().start,
    doc,
    notes,
    selection,
    setSelection,
    // Notes stay inside the audio (not `length`, which grows with them); no limit until its length is known.
    length: () => (playback.duration() > 0 ? playback.duration() : Infinity),
    playheadTime: () => playback.time(),
    onReveal: (note) => {
      if (!playback.playing()) seek(note.start);
      const current = view();
      const seconds = visibleSeconds(current, width());
      if (note.start < current.start || note.start + note.duration > current.start + seconds)
        setView(clampView({ ...current, start: note.start - seconds * 0.25 }, width(), length()));
    },
    onRefused: (message) => toast.add({ title: message }),
  });

  const tools = createTools();
  const onKeyUp = (event: KeyboardEvent) => tools.keyUp(event);
  // Copy, cut and paste come as these events from the keys and from the Edit menu alike; a text field keeps them.
  const onCopy = (event: ClipboardEvent) => {
    if (isTyping(document.activeElement)) return;
    cancelGestures();
    const text = event.type === "cut" ? editing.cutSelection() : editing.copySelection();
    if (text === null) return;
    event.preventDefault();
    if (text !== false) event.clipboardData?.setData("text/plain", text);
  };
  const onPaste = (event: ClipboardEvent) => {
    if (isTyping(document.activeElement)) return;
    cancelGestures();
    if (editing.pasteClip(event.clipboardData?.getData("text/plain"))) event.preventDefault();
  };

  let editArea: HTMLDivElement | undefined;
  let rollArea: HTMLDivElement | undefined;

  /**
   * Makes sure the sung pitch is there before editing starts: stored ones come at once; otherwise it is worked out now
   * (getting the pitch model first if needed), with "Opening the project…" over the editor. Opening never fails on it.
   */
  const preparePitch = async (signal: AbortSignal) => {
    if (!media("vocals")) return;
    const shown = setTimeout(() => setOpening((current) => current ?? null), 150);
    try {
      const result = await followProgress(
        () => native.project.pitch({ id: overview().id }, { signal }),
        signal,
        (progress) => setOpening(progress),
      );
      if (!signal.aborted) setPitch(result);
    } catch (error) {
      toast.add({ type: "error", title: "Couldn't follow the melody", description: errorMessage(error) });
    } finally {
      clearTimeout(shown);
      if (!signal.aborted) setOpening(undefined);
    }
  };

  onSettled(() => {
    playback.load();
    const pitchController = new AbortController();
    void preparePitch(pitchController.signal);
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
      if (isTyping(event.target)) return;
      // On macOS the Edit menu takes Cmd+Z; Windows and Linux have no menu bar, so the keys come here.
      const command = event.ctrlKey && !event.altKey && platform !== "macos" ? undoKey(event) : null;
      if (command) {
        event.preventDefault();
        runEditCommand(command);
        return;
      }
      // Esc: stops a drag first, then goes back to Select, then deselects.
      if (event.key === "Escape" && !gestureBusy() && tools.tool() !== "select") {
        tools.setTool("select");
        return;
      }
      if (breakEditing.key(event) || editing.key(event)) {
        event.preventDefault();
        return;
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && tools.keyDown(event)) {
        event.preventDefault();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === " ") {
        event.preventDefault();
        if (!playback.playing()) scrolledAway = false;
        playback.toggle();
      } else if (event.key === "." || event.key === ",") {
        event.preventDefault();
        goToLine(stepLine(lines(), playback.time(), event.key === "." ? 1 : -1));
      } else if (event.key === "z" || event.key === "Z") {
        event.preventDefault();
        goToLine(lines()[lineIndexAt(lines(), playback.time())], true);
      }
    };
    window.addEventListener("keydown", onKey);

    window.addEventListener("keyup", onKeyUp);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    // A drag in progress was worked out for the chart before the undo: it stops first.
    const stopEditing = setEditHandler({
      undo: () => {
        cancelGestures();
        doc().undo();
      },
      redo: () => {
        cancelGestures();
        doc().redo();
      },
      // The Edit menu's Cut, Copy and Paste (macOS); the keys elsewhere come as clipboard events (`onCopy`).
      // A drag in progress stops first here too (it was worked out for the chart before).
      copy: () => {
        cancelGestures();
        return editing.copySelection();
      },
      cut: () => {
        cancelGestures();
        return editing.cutSelection();
      },
      paste: (text) => {
        cancelGestures();
        return editing.pasteClip(text);
      },
    });
    return () => {
      stopEditing();
      cancelGestures();
      autoScroll.end();
      pitchController.abort();
      observer.disconnect();
      editArea?.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
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
    <div class="flex h-dvh min-h-0 flex-col overflow-hidden bg-background" data-testid="project">
      <TitleBar
        start={
          <>
            <HistoryButton label={doc().undoLabel()} action="Undo" onClick={() => runEditCommand("undo")} testid="undo">
              <Undo2Icon />
            </HistoryButton>
            <HistoryButton label={doc().redoLabel()} action="Redo" onClick={() => runEditCommand("redo")} testid="redo">
              <Redo2Icon />
            </HistoryButton>
            <div class="mx-1.5 h-4 w-px bg-bar-border" aria-hidden="true" />
            <ToolSwitch tool={tools.tool()} onTool={tools.setTool} />
          </>
        }
      >
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
        <div
          ref={(element) => (editArea = element)}
          class="flex min-w-0 flex-1 flex-col overflow-hidden"
          data-testid="editor"
        >
          <OverviewBar
            lines={lines()}
            length={length()}
            view={view()}
            width={width()}
            playhead={playback.time()}
            duet={duet()}
            onScrollTo={(seconds) => changeView({ ...view(), start: seconds - visibleSeconds(view(), width()) / 2 })}
          />
          <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <TimeRuler view={view()} width={width()} onSeek={seek} autoScroll={autoScroll} />
            <BreakLane
              breaks={visibleBreaks()}
              view={view()}
              selected={breakEditing.selected()}
              drag={breakEditing.drag()}
              onDown={(item, event) => breakEditing.breakDown(item, event, view().pxPerSecond)}
              onDoubleClick={(item) => breakEditing.breakDoubleClick(item)}
              onLaneDoubleClick={(seconds) => breakEditing.laneDoubleClick(seconds)}
            />
            <div ref={(element) => (rollArea = element)} class="flex min-h-0 flex-1">
              <PianoRoll
                notes={visibleNotes()}
                breaks={visibleBreaks()}
                range={range()}
                view={view()}
                width={width()}
                height={size().height}
                pitch={showPitch() ? pitch() : null}
                selected={selectedIds()}
                overlapping={overlaps()}
                onNoteDown={(note, event, part, scale) => {
                  breakEditing.deselect();
                  editing.noteDown(note, event, part, scale);
                }}
                drag={editing.drag()}
                onEmptyClick={(seconds) => {
                  breakEditing.deselect();
                  editing.emptyClick();
                  seek(seconds);
                }}
                onBox={(area, add) => {
                  breakEditing.deselect();
                  editing.box(area, add);
                }}
                tool={tools.tool()}
                onDrawDown={(at, event, scale) => editing.drawDown(event, at, scale)}
                drawing={editing.drawing()}
                onEmptyDoubleClick={(at) => editing.emptyDoubleClick(at)}
                cut={editing.cut()}
                onHover={(note, seconds) => editing.hover(note, seconds)}
                onSplit={(note, seconds, every) => editing.splitAt(note, seconds, every)}
                onNoteDoubleClick={(note) => editing.noteDoubleClick(note)}
                editingLyric={editing.editingLyric()}
                onLyricDone={(text, move) => editing.finishLyric(text, move)}
                autoScroll={autoScroll}
              />
            </div>
            <LyricsLane lines={visibleLines()} all={lines()} view={view()} duet={duet()} />
            <Show when={opening() !== undefined}>
              <OpeningOverlay progress={opening() ?? null} />
            </Show>
            <Playhead view={view()} width={width()} time={playback.time()} onScrub={seek} autoScroll={autoScroll} />
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
        showPitch={pitch() ? showPitch() : undefined}
        onShowPitch={setShowPitch}
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

/** Over the editor while opening finishes: what is being prepared, and how far it is. */
function OpeningOverlay(props: { progress: ImportProgress | null }) {
  return (
    <div
      class="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-background/85"
      aria-live="polite"
      data-testid="editor-opening"
    >
      <span class="flex items-center gap-2 text-[13px] font-medium text-foreground">
        <LoaderCircleIcon class="size-4 animate-spin text-primary" />
        Opening the project…
      </span>
      <span class="text-[11.5px] text-muted-foreground">{props.progress?.step ?? "Following the melody"}</span>
      <div class="w-56">
        <progress aria-label="Opening progress" max="100" value={percentOf(props.progress)} class={progressBarClass} />
      </div>
    </div>
  );
}
