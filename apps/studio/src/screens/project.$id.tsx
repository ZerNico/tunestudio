import { getRouteApi, useNavigate, useRouter } from "@tanstack/solid-router";
import { createEffect, createMemo, createSignal, flush, onSettled, Show } from "solid-js";
import DownloadIcon from "~icons/lucide/download";
import LoaderCircleIcon from "~icons/lucide/loader-circle";
import Redo2Icon from "~icons/lucide/redo-2";
import Undo2Icon from "~icons/lucide/undo-2";
import XIcon from "~icons/lucide/x";

import { AutoPitchButton, HistoryButton, MergeButton, ToolSwitch } from "~/components/editor/edit-controls";
import { BreakLane, LyricsLane, OverviewBar, TimeRuler } from "~/components/editor/lanes";
import { NoteMenu, type NoteMenuActions } from "~/components/editor/note-menu";
import { GUTTER_PX, PianoRoll } from "~/components/editor/piano-roll";
import { Playhead } from "~/components/editor/playhead";
import type { ArtworkActions } from "~/components/editor/song-artwork";
import { SongDetails } from "~/components/editor/song-details";
import { Transport } from "~/components/editor/transport";
import { follow as followProgress, percentOf, progressBarClass } from "~/components/new-project/progress";
import { ReplaceExportDialog } from "~/components/project/replace-export-dialog";
import { TitleBar } from "~/components/title-bar";
import { Button } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";
import { CHART_STEPS } from "~/lib/chart-steps";
import { platform, revealLabel } from "~/lib/desktop";
import { isTyping, pasteFromClipboard, runEditCommand, setEditHandler } from "~/lib/edit-commands";
import { createAutoPitchJob } from "~/lib/editor/auto-pitch-job";
import { createAutoScroll } from "~/lib/editor/autoscroll";
import { createBreakEditing } from "~/lib/editor/break-editing";
import {
  chartEnd,
  type DrawnNote,
  type LineBreak,
  drawnNotes,
  lineBreaks,
  lineIndexAt,
  lineSpans,
  longest,
  onGrid,
  spanOf,
  stepLine,
} from "~/lib/editor/chart";
import { createChartDocument } from "~/lib/editor/document";
import { overlapping } from "~/lib/editor/edits";
import { createLoop } from "~/lib/editor/loop";
import { createNoteEditing, previewChart } from "~/lib/editor/note-editing";
import { createPlayback } from "~/lib/editor/playback";
import { createEditorPrefs } from "~/lib/editor/prefs";
import { NOTHING, type Selection } from "~/lib/editor/selection";
import { createSongMarkers } from "~/lib/editor/song-markers";
import { createTones } from "~/lib/editor/tones";
import { createTools } from "~/lib/editor/tools";
import {
  clampView,
  fitRange,
  follow,
  onPage,
  revealSpan,
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
import { errorMessage, isAbort } from "~/lib/native/errors";
import type { ImportProgress, ProjectOverview, SungPitch } from "~/lib/native/types";

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
/** Brought on screen, a line starts this share of the screen from the left, a note (Tab) further in. */
const LINE_LEAD = 0.1;
const NOTE_LEAD = 0.25;
/** A line that would fill more than this share of the screen is fitted to it instead. */
const FIT_SHARE = 0.9;

/**
 * An open project: the chart editor. The editing area shows the song at a glance (overview), the notes against time
 * and pitch, and each line's text, with playback of the song, its vocals or its music. The song's details, files,
 * timing and lyrics are in the Song details dialog (from its name in the title bar). Notes are edited with the keys and
 * clicks in `note-editing.ts`.
 */
export default function ProjectScreen() {
  const data = route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const overview = () => data().overview;
  const [exporting, setExporting] = createSignal(false);
  const [replacing, setReplacing] = createSignal<{ folder: string; existing: string } | null>(null);

  /** The selected notes and line breaks; undo and redo bring back the selection that went with a step. */
  const [selection, setSelection] = createSignal<Selection>(NOTHING);
  /**
   * The chart being edited, with its history. Made anew when the project's chart is loaded again (when saving failed),
   * which also starts the history over.
   */
  const doc = createMemo(() =>
    createChartDocument<Selection>({
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
  /**
   * The media as changed since the project opened (a new cover or background), if they were: the overview is only
   * read when the project opens, and reading it again would start the editor over.
   */
  const [changedMedia, setChangedMedia] = createSignal<ProjectOverview["media"] | null>(null);
  const projectMedia = () => changedMedia() ?? overview().media;
  const artworkActions: ArtworkActions = {
    set: async (role, choice) => {
      const updated = await native.project.setArtwork({ id: overview().id, role, choice });
      setChangedMedia(updated.media);
    },
    findCovers: () =>
      native.youtube.findCovers({
        artist: chart().song.artist,
        title: chart().song.title,
        duration: playback.duration() || null,
      }),
    chooseImage: () => native.dialogs.chooseCoverImage(),
    onError: (title, error) => {
      if (!isAbort(error)) toast.add({ type: "error", title, description: errorMessage(error) });
    },
  };
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const notes = createMemo(() => drawnNotes(chart()));
  const lines = createMemo(() => lineSpans(chart()));
  const selectedIds = createMemo(() => new Set(selection().notes));
  const selectedBreaks = createMemo(() => new Set(selection().breaks));
  const selectedNotes = createMemo(() => notes().filter((note) => selectedIds().has(note.id)));
  const overlaps = createMemo(() => overlapping(chart()));
  const longestNote = createMemo(() => longest(notes()));
  const longestLine = createMemo(() => longest(lines()));
  const duet = () => chart().singers.length > 1;
  const breaks = createMemo(() => lineBreaks(chart()));
  /** What is sung in the vocals (null: none, or not there yet). */
  const [pitch, setPitch] = createSignal<SungPitch | null>(null);
  const [showPitch, setShowPitch] = createSignal(true);
  /** Opening isn't finished: the pitch is being prepared (shown after a moment, with its progress). */
  const [opening, setOpening] = createSignal<ImportProgress | null | undefined>(undefined);

  /** A media file's URL by role (the project's as changed: a new cover). */
  const media = (role: string) => projectMedia().find((item) => item.role === role)?.url;
  const [view, setView] = createSignal<TimeView>({ start: 0, pxPerSecond: 80 });
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  /**
   * The user scrolled while playing: the view stops following the playhead until playback starts again, the playhead
   * is moved, or it comes back on screen.
   */
  let scrolledAway = false;
  let placed = false;
  const width = () => size().width;
  const length = () => Math.max(playback.duration(), chartEnd(notes()) + 1, 1);

  const prefs = createEditorPrefs();
  const tones = createTones({ notes });
  /** A time on the chart's grid. */
  const snap = (seconds: number) => onGrid(chart(), seconds);
  const loop = createLoop({ snap, length, onSeek: (seconds) => seek(seconds) });
  const songMarkers = createSongMarkers({
    song: () => chart().song,
    length,
    snap,
    lines,
    onChange: (label, patch) => doc().edit(label, (tx) => tx.updateSong(patch)),
    onSeek: (seconds) => seek(seconds),
  });

  const playback = createPlayback(
    { audio: media("audio"), vocals: media("vocals"), instrumental: media("instrumental") },
    (time) => {
      const back = loop.back(time);
      if (back !== null) playback.seek(back);
      const now = back ?? time;
      if (prefs.tones()) tones.frame(now, playback.speed());
      // Scrolled away, then the playhead came back on screen (or the view back to it): following goes on.
      if (scrolledAway && width() > 0 && onPage(view(), now, width())) scrolledAway = false;
      if (prefs.following() && !scrolledAway && width() > 0)
        setView((current) => follow(current, now, width(), length()));
    },
    (time) => loop.startAt(time),
  );
  // Tones stop with playback, at another speed (they start again on the next frame) and when turned off.
  createEffect(
    () => [playback.playing(), playback.speed(), prefs.tones()] as const,
    () => tones.stop(),
  );
  const changeFollowing = (next: boolean) => {
    prefs.setFollowing(next);
    if (next) scrolledAway = false;
  };
  // The engines take the volumes as they are set (and as remembered, from the start).
  createEffect(
    () => prefs.volumes(),
    (volumes) => {
      playback.setVolume(volumes.song);
      tones.setVolume(volumes.tones);
    },
  );
  /** L: looping on (over the selected notes when there are any) or off; says what to do when there's nothing. */
  const toggleLoop = () => {
    if (!loop.toggle(spanOf(selectedNotes())))
      toast.add({ title: "Drag on the time ruler or select notes to loop them." });
  };

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
    selection,
    setSelection,
    onRefused: (message) => toast.add({ title: message }),
  });
  /** Every gesture: a note drag or drawing, a break drag, a loop range or a song marker on the ruler. */
  const gestureBusy = () => editing.busy() || breakEditing.busy() || loop.busy() || songMarkers.busy();
  const cancelGestures = () => {
    editing.cancel();
    breakEditing.cancel();
    loop.cancel();
    songMarkers.cancel();
  };

  const visibleNotes = createMemo(() =>
    visibleItems(notes(), view().start, view().start + visibleSeconds(view(), width()), longestNote()),
  );
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
    const span = { start: line.start, end: line.start + line.duration };
    // A line that (nearly) fills the screen, or with Z, is fitted; else it is only brought on screen.
    if (fit || line.duration >= visibleSeconds(view(), width()) * FIT_SHARE)
      setView(fitRange(span.start, span.end, width(), length()));
    else setView(revealSpan(view(), span, width(), length(), LINE_LEAD));
  };

  const autoPitch = createAutoPitchJob({
    notes,
    doc,
    request: (ids, signal, onProgress) =>
      followProgress(() => native.project.autoPitch({ id: overview().id, notes: ids }, { signal }), signal, onProgress),
    apply: (pitches, asked) => editing.applyPitches(pitches, asked),
    onMessage: ({ title, description, error }) => toast.add({ type: error ? "error" : undefined, title, description }),
  });

  const editing = createNoteEditing({
    onAutoPitch: (ids) => autoPitch.run(ids),
    onPitch: (midi) => {
      if (prefs.tones()) tones.preview(midi);
    },
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
      setView(revealSpan(view(), { start: note.start, end: note.start + note.duration }, width(), length(), NOTE_LEAD));
    },
    onRefused: (message) => toast.add({ title: message }),
    breaks,
    oneBreak: breakEditing,
  });

  const visibleBreaks = createMemo(() => {
    const from = view().start;
    const to = from + visibleSeconds(view(), width());
    // During a move the breaks are drawn as it would leave them (those going along with a gap too); a break dragged on
    // its own where it would go.
    const moving = editing.drag();
    const dragged = breakEditing.drag();
    return (moving ? lineBreaks(previewChart(chart(), moving)) : breaks())
      .map((item) =>
        dragged?.lineId === item.lineId ? Object.assign({}, item, { time: dragged.time, auto: false }) : item,
      )
      .filter((item) => item.time >= from && item.time <= to);
  });
  const breakDown = (item: LineBreak, event: PointerEvent) => editing.breakDown(item, event, view().pxPerSecond);
  /** The note a right-click is on, until the note menu opens (it is told on the way up). */
  let menuNote: DrawnNote | null = null;
  const noteMenu: NoteMenuActions = {
    open: () => {
      cancelGestures();
      const note = menuNote;
      menuNote = null;
      if (note) editing.menuOpen(note);
      return note !== null;
    },
    canAutoPitch: () => !autoPitch.busy() && selectedIds().size > 0,
    autoPitch: () => editing.commands.autoPitch(),
    canSplitAtPlayhead: () => editing.commands.canSplitAtPlayhead(),
    splitAtPlayhead: () => editing.commands.splitAtPlayhead(),
    canMerge: () => editing.commands.canMerge(),
    merge: () => editing.commands.merge(),
    flagOn: (flag) => editing.commands.flagOn(flag),
    toggleFlag: (flag) => editing.commands.toggleFlag(flag),
    cut: () => runEditCommand("cut"),
    copy: () => runEditCommand("copy"),
    paste: () => pasteFromClipboard(),
    remove: () => editing.commands.remove(),
    selectAll: () => editing.commands.selectAll(),
  };

  /**
   * The pitch rows: the notes' lowest to highest with some room. While a note is dragged they only grow, and just to
   * fit the dragged notes (no room added: the pointer's spot would become a further pitch and the note run off); held
   * past the top or bottom, the drag goes on a semitone at a time. Let go, they fit the notes again.
   */
  let shownRange: PitchRange | null = null;
  const range = createMemo(() => {
    const drag = editing.drag();
    if (!drag || !shownRange) return (shownRange = pitchRange(notes().map((note) => note.pitch)));
    const moved = notes()
      .filter((note) => drag.ids.has(note.id))
      .map((note) => note.pitch + drag.pitch);
    shownRange = {
      low: Math.min(shownRange.low, ...moved),
      high: Math.max(shownRange.high, ...moved),
    };
    return shownRange;
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
      } else if ((event.key === "l" || event.key === "L") && !event.shiftKey && !event.repeat) {
        event.preventDefault();
        toggleLoop();
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
      autoPitch.stop();
      pitchController.abort();
      observer.disconnect();
      editArea?.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
      playback.dispose();
      tones.dispose();
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
            <ToolSwitch class="mx-3" tool={tools.tool()} onTool={tools.setTool} />
            <AutoPitchButton
              status={autoPitch.busy() ? (autoPitch.progress()?.step ?? null) : undefined}
              percent={percentOf(autoPitch.progress() ?? null) ?? null}
              canStart={selectedIds().size > 0}
              onStart={() => editing.commands.autoPitch()}
              onStop={() => autoPitch.stop()}
            />
            <MergeButton canMerge={editing.commands.canMerge()} onMerge={() => editing.commands.merge()} />
          </>
        }
      >
        <button
          type="button"
          class="mr-auto flex max-w-[420px] min-w-0 cursor-pointer items-baseline gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] hover:bg-sage-20"
          title="Song details"
          onClick={() => setDetailsOpen(true)}
          data-testid="open-song-details"
        >
          <h1 class="m-0 truncate text-[12.5px] font-medium text-foreground">{chart().song.title || "Untitled"}</h1>
          <span class="truncate text-muted-foreground">· {chart().song.artist || "Unknown artist"}</span>
        </button>

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
            markers={songMarkers}
          />
          <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <TimeRuler
              view={view()}
              width={width()}
              loop={loop}
              markers={songMarkers}
              length={length()}
              autoScroll={autoScroll}
            />
            <BreakLane
              breaks={visibleBreaks()}
              view={view()}
              selected={selectedBreaks()}
              drag={breakEditing.drag() ?? editing.markerDrag()}
              onDown={breakDown}
              onDoubleClick={(item) => breakEditing.breakDoubleClick(item)}
              onLaneDoubleClick={(seconds) => breakEditing.laneDoubleClick(seconds)}
            />
            <div ref={(element) => (rollArea = element)} class="flex min-h-0 flex-1">
              <NoteMenu actions={noteMenu}>
                <PianoRoll
                  onNoteContextMenu={(note) => (menuNote = note)}
                  notes={visibleNotes()}
                  breaks={visibleBreaks()}
                  range={range()}
                  view={view()}
                  width={width()}
                  height={size().height}
                  pitch={showPitch() ? pitch() : null}
                  selected={selectedIds()}
                  selectedBreaks={selectedBreaks()}
                  onBreakDown={breakDown}
                  overlapping={overlaps()}
                  pending={autoPitch.pending()}
                  played={{ start: songMarkers.at("start"), end: songMarkers.at("end") }}
                  onNoteDown={(note, event, part, scale) => editing.noteDown(note, event, part, scale)}
                  drag={editing.drag()}
                  onEmptyClick={(seconds) => {
                    editing.emptyClick();
                    seek(seconds);
                  }}
                  onBox={(area, add) => editing.box(area, add)}
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
              </NoteMenu>
            </div>
            <LyricsLane lines={visibleLines()} all={lines()} view={view()} duet={duet()} />
            <Show when={opening() !== undefined}>
              <OpeningOverlay progress={opening() ?? null} />
            </Show>
            <Playhead
              view={view()}
              width={width()}
              time={playback.time()}
              onScrub={seek}
              onDoubleClick={(seconds) => loop.clearAt(seconds)}
              autoScroll={autoScroll}
            />
          </div>
          <Show when={notes().length === 0}>
            <p
              class="m-0 border-b border-border px-4 py-2 text-[11.5px] text-muted-foreground"
              data-testid="editor-empty"
            >
              The chart is empty. Draw notes with the Draw tool (D), or double-click in the roll to add one.
            </p>
          </Show>
        </div>
      </div>
      <Transport
        playback={playback}
        length={length()}
        onZoom={(factor) => changeView(zoomAt(view(), factor, width() / 2, width(), length()))}
        showPitch={pitch() ? showPitch() : undefined}
        onShowPitch={setShowPitch}
        looping={loop.on()}
        onLoop={toggleLoop}
        following={prefs.following()}
        onFollow={changeFollowing}
        tones={prefs.tones()}
        onTones={prefs.setTones}
        volumes={prefs.volumes()}
        onVolume={prefs.setVolume}
      />

      <SongDetails
        open={detailsOpen()}
        onOpenChange={setDetailsOpen}
        doc={doc()}
        chart={chart()}
        media={projectMedia()}
        artwork={artworkActions}
        markers={songMarkers}
        selectedLines={() => {
          const chosen = new Set(selectedNotes().map((note) => note.lineId));
          return lines().filter((line) => chosen.has(line.id));
        }}
        playheadTime={() => playback.time()}
        onPlayFrom={(seconds) => {
          seek(seconds);
          playback.play();
        }}
        lyrics={overview().lyrics?.lines}
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
      <span class="text-[11.5px] text-muted-foreground">{props.progress?.step ?? CHART_STEPS.melody}</span>
      <div class="w-56">
        <progress aria-label="Opening progress" max="100" value={percentOf(props.progress)} class={progressBarClass} />
      </div>
    </div>
  );
}
