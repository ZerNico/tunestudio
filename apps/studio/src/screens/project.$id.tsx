import { getRouteApi, useNavigate, useRouter } from "@tanstack/solid-router";
import { createEffect, createMemo, createSignal, flush, onSettled, Show, untrack } from "solid-js";
import CircleHelpIcon from "~icons/lucide/circle-help";
import LoaderCircleIcon from "~icons/lucide/loader-circle";
import Redo2Icon from "~icons/lucide/redo-2";
import Undo2Icon from "~icons/lucide/undo-2";
import XIcon from "~icons/lucide/x";

import { ChartRangeDialog } from "~/components/editor/chart-range-dialog";
import {
  AutoPitchButton,
  ChartRangeButton,
  HistoryButton,
  LineBreakButton,
  MergeButton,
  SungBySwitch,
  ToolSwitch,
} from "~/components/editor/edit-controls";
import { HelpDialog } from "~/components/editor/help-dialog";
import { IconButton } from "~/components/editor/icon-button";
import { BreakLane, LyricsLane, OverviewBar, TimeRuler, WaveformLane } from "~/components/editor/lanes";
import { NoteMenu, type NoteMenuActions } from "~/components/editor/note-menu";
import { GUTTER_PX, PianoRoll } from "~/components/editor/piano-roll";
import { Playhead } from "~/components/editor/playhead";
import { SingerSwitch } from "~/components/editor/singer-switch";
import { SongDetails } from "~/components/editor/song-details";
import { Transport } from "~/components/editor/transport";
import { VideoPreview } from "~/components/editor/video-preview";
import { ExportMenu } from "~/components/project/export-menu";
import { ProblemsMenu } from "~/components/project/problems-menu";
import { ReplaceExportDialog } from "~/components/project/replace-export-dialog";
import { TitleBar } from "~/components/title-bar";
import { Button } from "~/components/ui/button";
import { ProgressBar } from "~/components/ui/progress-bar";
import { toast, toastError } from "~/components/ui/toast";
import type { TimeRange } from "~/lib/chart-range";
import { onMenuCommand, platform } from "~/lib/desktop";
import {
  controlKey,
  inMenu,
  openContextMenu,
  isTyping,
  pasteFromClipboard,
  runEditCommand,
  setEditHandler,
} from "~/lib/edit-commands";
import { createAutoPitchJob } from "~/lib/editor/auto-pitch-job";
import { createAutoScroll } from "~/lib/editor/autoscroll";
import { createBreakEditing } from "~/lib/editor/break-editing";
import {
  chartEnd,
  type DrawnNote,
  type LineBreak,
  drawnNotes,
  gridStep,
  lineBreaks,
  lineIndexAt,
  lineSpans,
  longest,
  onGrid,
  spanOf,
  stepLine,
} from "~/lib/editor/chart";
import { createChartRangeJob } from "~/lib/editor/chart-range-job";
import { type ChartProblem, chartProblems } from "~/lib/editor/checks";
import { createChartDocument } from "~/lib/editor/document";
import { overlapping } from "~/lib/editor/edits";
import { listenForKeyHints } from "~/lib/editor/key-hints";
import { createLineTextEditing } from "~/lib/editor/line-text-editing";
import { createLoop } from "~/lib/editor/loop";
import { createNoteEditing, previewChart } from "~/lib/editor/note-editing";
import { createPlayback } from "~/lib/editor/playback";
import { createEditorPrefs } from "~/lib/editor/prefs";
import { createProjectMedia } from "~/lib/editor/project-media";
import { createScrub } from "~/lib/editor/scrub";
import { breaksOnly, NOTHING, notesOnly, type Selection } from "~/lib/editor/selection";
import { keyOf } from "~/lib/editor/shortcuts";
import { createSingAlong, microphoneProblem } from "~/lib/editor/sing-along";
import { addSinger, removeSinger, singerLabel, singerOf } from "~/lib/editor/singers";
import { createSingersView } from "~/lib/editor/singers-view";
import { createSongExport } from "~/lib/editor/song-export";
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
import { setFlushHandler } from "~/lib/flush";
import { codeOfLanguage } from "~/lib/languages";
import { createLatest } from "~/lib/latest";
import type { EditCommand } from "~/lib/native/channel";
import { native } from "~/lib/native/client";
import { errorMessage } from "~/lib/native/errors";
import { follow as followProgress, percentOf } from "~/lib/native/progress";
import type { Progress, SungPitch, Waveform } from "~/lib/native/types";
import { CHART_STEPS } from "~/lib/steps";

const route = getRouteApi("/project/$id");

/** Ctrl+Z undoes; Ctrl+Shift+Z and Ctrl+Y redo (where Undo isn't in a menu). */
function undoKey(event: KeyboardEvent): EditCommand | null {
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}

/** How much of the song the view shows at first. */
const FIRST_VIEW_SECONDS = 12;
/** Brought on screen, a line starts this share of the screen from the left, a note (Tab) further in. */
const LINE_LEAD = 0.1;
const NOTE_LEAD = 0.25;
/** A line that would fill more than this share of the screen is fitted to it instead. */
const FIT_SHARE = 0.9;
/** Two clicks this close (ms) are a double-click, which adds a note and leaves the playhead where it was. */
const DOUBLE_CLICK_MS = 500;

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
  /** In a duet: the singer edits go to, and the singers hidden from view (not saved: hidden notes are left alone). */
  const singersView = createSingersView(chart);
  const sungShown = (item: { singer: number }) => !singersView.isHidden(item.singer);
  const mediaFiles = createProjectMedia({ overview, song: () => chart().song, duration: () => playback.duration() });
  const projectMedia = mediaFiles.media;
  const separating = mediaFiles.separating;
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const [helpOpen, setHelpOpen] = createSignal(false);
  /** Help opens over the editor: a drag under way stops first. */
  const openHelp = () => {
    cancelGestures();
    setHelpOpen(true);
  };
  const allNotes = createMemo(() => drawnNotes(chart()));
  const notes = createMemo(() => allNotes().filter(sungShown));
  const lines = createMemo(() => lineSpans(chart()).filter(sungShown));
  const selectedIds = createMemo(() => new Set(selection().notes));
  const selectedBreaks = createMemo(() => new Set(selection().breaks));
  const selectedNotes = createMemo(() => notes().filter((note) => selectedIds().has(note.id)));
  const overlaps = createMemo(() => overlapping(chart()));
  const longestNote = createMemo(() => longest(notes()));
  const longestLine = createMemo(() => longest(lines()));
  const duet = () => chart().singers.length > 1;
  /** Both singers of a duet shown: the other one is dimmed, and gets the lyrics lane's second row. */
  const bothShown = () => duet() && chart().singers.every((singer) => !singersView.isHidden(singer.index));
  const activeSinger = () => (bothShown() ? singersView.index() : undefined);
  const breaks = createMemo(() => lineBreaks(chart()).filter(sungShown));
  /** What is sung in the vocals (null: none, or not there yet). */
  const [pitch, setPitch] = createSignal<SungPitch | null>(null);
  const [waveform, setWaveform] = createSignal<Waveform | null>(null);
  /** Opening isn't finished: the pitch is being prepared (shown after a moment, with its progress). */
  const [opening, setOpening] = createSignal<Progress | null | undefined>(undefined);

  /** A media file's URL by role (the project's as changed: a new cover). */
  const media = (role: string) => projectMedia().find((item) => item.role === role)?.url;
  // Scrolling or zooming against a limit (the song's ends, the deepest zoom) keeps the view: nothing is drawn again.
  const [view, setView] = createSignal<TimeView>(
    { start: 0, pxPerSecond: 80 },
    { equals: (a, b) => a.start === b.start && a.pxPerSecond === b.pxPerSecond },
  );
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  /**
   * The user scrolled while playing: the view stops following the playhead until playback starts again, the playhead
   * is moved, or it comes back on screen.
   */
  let scrolledAway = false;
  let placed = false;
  const width = () => size().width;
  /** Where the last note ends: the timeline's length is read every frame and by every block of the overview bar. */
  const notesEnd = createMemo(() => chartEnd(allNotes()));
  const length = () => Math.max(playback.duration(), notesEnd() + 1, 1);

  const prefs = createEditorPrefs();
  const tones = createTones({ notes });
  /** The playhead's drag heard: the selected source where it is, while paused. */
  const scrub = createScrub({
    url: () => {
      const source = playback.source();
      return source ? playbackUrls()[source] : undefined;
    },
  });
  const singAlong = createSingAlong({ notes, length });
  const toggleSingAlong = (on: boolean) => {
    if (!on) return singAlong.stop();
    singAlong.start().catch((error: unknown) => {
      console.warn(error);
      toast.add({
        type: "error",
        title: "Couldn't use the microphone",
        description: microphoneProblem(error, platform),
      });
    });
  };
  /** A time on the chart's grid. */
  const snap = (seconds: number) => onGrid(chart(), seconds);
  const loop = createLoop({ snap, length, onSeek: (seconds) => seek(seconds) });
  const songMarkers = createSongMarkers({
    song: () => chart().song,
    length,
    snap,
    // Every singer's, hidden or not: the medley is the song's.
    lines: () => lineSpans(chart()),
    onChange: (label, patch) => doc().edit(label, (tx) => tx.updateSong(patch)),
    onSeek: (seconds) => seek(seconds),
  });

  /** The sources playback plays: the song, vocals and music, as they are now. */
  const playbackUrls = () => ({ audio: media("audio"), vocals: media("vocals"), instrumental: media("instrumental") });
  const playback = createPlayback(
    // Replaced files reach it through `setUrls`.
    untrack(playbackUrls),
    {
      onFrame: (time) => {
        const back = loop.back(time);
        if (back !== null) playback.seek(back);
        const now = back ?? time;
        if (prefs.tones()) tones.frame(now, playback.speed());
        if (singAlong.on()) singAlong.frame(now, playback.speed());
        // Scrolled away, then the playhead came back on screen (or the view back to it): following goes on.
        if (scrolledAway && width() > 0 && onPage(view(), now, width())) scrolledAway = false;
        if (prefs.following() && !scrolledAway && width() > 0)
          setView((current) => follow(current, now, width(), length()));
      },
      startAt: (time) => loop.startAt(time),
      onEnd: () => loop.restart(),
    },
  );
  /** Space or the transport's button: starting to play follows the playhead again. */
  const togglePlay = () => {
    if (!playback.playing()) scrolledAway = false;
    playback.toggle();
  };
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
      scrub.setVolume(volumes.song);
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
  /** Notes stay inside the audio (not `length`, which grows with them); no limit until its length is known. */
  const editingLength = () => (playback.duration() > 0 ? playback.duration() : Infinity);
  const breakEditing = createBreakEditing({
    autoScroll,
    viewStart: () => view().start,
    doc,
    singer: () => singersView.id(),
    singers: () => {
      const active = singersView.id();
      const shown = chart()
        .singers.filter((singer) => !singersView.isHidden(singer.index))
        .map((singer) => singer.id);
      return shown.toSorted((a, b) => Number(b === active) - Number(a === active));
    },
    onSinger: (id) => {
      const singer = chart().singers.find((item) => item.id === id);
      if (singer) singersView.choose(singer.index);
    },
    playheadTime: () => playback.time(),
    busy: () => editing.busy() || loop.busy() || songMarkers.busy(),
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

  /** Moves the playhead, kept on the song; returns where it went (the playback's time reads the old one until then). */
  const seek = (seconds: number) => {
    scrolledAway = false;
    const at = Math.min(length(), Math.max(0, seconds));
    playback.seek(at);
    return at;
  };
  /**
   * A click on empty space in the roll moves the playhead at once; a double-click (which adds a note there) puts it back
   * where it was before, as playing has moved it on since.
   */
  let beforeClick: { time: number; at: number } | null = null;
  const clickSeek = (seconds: number) => {
    const now = performance.now();
    // The second click of a double-click keeps where the first one started.
    if (!beforeClick || now - beforeClick.at > DOUBLE_CLICK_MS) beforeClick = { time: playback.time(), at: now };
    seek(seconds);
  };
  /** The playhead dragged (its head or its line): heard there while paused. */
  const scrubTo = (seconds: number) => {
    const at = seek(seconds);
    if (!playback.playing()) scrub.at(at);
  };
  const undoClickSeek = () => {
    const before = beforeClick;
    beforeClick = null;
    if (!before || performance.now() - before.at > DOUBLE_CLICK_MS) return;
    const played = playback.playing() ? ((performance.now() - before.at) / 1000) * playback.speed() : 0;
    seek(before.time + played);
  };
  const changeView = (next: TimeView) => {
    if (playback.playing()) scrolledAway = true;
    setView(clampView(next, width(), length()));
  };
  /** What's wrong with the chart, as it is now. */
  const problems = createMemo(() => chartProblems(chart(), playback.duration()));
  /** Selects a problem's notes (or line break) and brings them on screen, fitting them when they don't fit. */
  const showProblem = (problem: ChartProblem) => {
    // Its notes may be a hidden singer's.
    singersView.showAll();
    setSelection(problem.lineId === undefined ? notesOnly(problem.noteIds) : breaksOnly([problem.lineId]));
    if (!playback.playing()) seek(problem.start);
    const span = { start: problem.start, end: problem.end };
    // As a scroll would: while playing, following waits until the playhead is back on the page.
    if (span.end - span.start >= visibleSeconds(view(), width()) * FIT_SHARE)
      changeView(fitRange(span.start, span.end, width(), length()));
    else changeView(revealSpan(view(), span, width(), length(), NOTE_LEAD));
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
    media: projectMedia,
    request: (ids, signal, onProgress) =>
      followProgress(() => native.project.autoPitch({ id: overview().id, notes: ids }, { signal }), signal, onProgress),
    apply: (pitches, asked) => editing.applyPitches(pitches, asked),
    onMessage: ({ title, description, error }) => toast.add({ type: error ? "error" : undefined, title, description }),
  });

  const [chartingRange, setChartingRange] = createSignal<{ range: TimeRange; singerId: number } | null>(null);
  const rangeJob = createChartRangeJob({
    doc,
    project: () => overview().id,
    media: projectMedia,
    request: (input, signal, onProgress) =>
      followProgress(() => native.project.chartRange(input, { signal }), signal, onProgress),
    onDone: () => setChartingRange(null),
  });
  // A range kept with looping off is drawn faintly and easy to miss, so only a looping one counts.
  const requestedRange = () => (loop.on() ? loop.range() : null) ?? spanOf(selectedNotes());
  /** Auto pitch listens to the vocals: not without them, nor while they are made again. */
  const canAutoPitch = () => !!media("vocals") && !chartingRange() && !autoPitch.busy() && separating() === undefined;
  // Without a range the button stays enabled and says what to do, as L does.
  const canChartRange = () =>
    !!media("vocals") && !gestureBusy() && !autoPitch.busy() && !chartingRange() && separating() === undefined;
  const openChartRange = () => {
    if (!canChartRange()) return;
    const requested = requestedRange();
    if (!requested) {
      toast.add({ title: "Drag on the time ruler or select notes to chart them." });
      return;
    }
    const singerId = editing.activeSinger();
    if (singerId === null) return;
    cancelGestures();
    playback.pause();
    rangeJob.clearError();
    setChartingRange({ range: { ...requested }, singerId });
  };

  const editing = createNoteEditing({
    onAutoPitch: (ids) => {
      if (!media("vocals")) toast.add({ title: "Auto pitch listens to the vocals. Separate the voice first." });
      else if (canAutoPitch()) autoPitch.run(ids);
    },
    onPitch: (midi) => {
      if (prefs.tones()) tones.preview(midi);
    },
    autoScroll,
    viewStart: () => view().start,
    doc,
    notes,
    selection,
    setSelection,
    length: editingLength,
    playheadTime: () => playback.time(),
    onReveal: (note) => {
      if (!playback.playing()) seek(note.start);
      changeView(
        revealSpan(view(), { start: note.start, end: note.start + note.duration }, width(), length(), NOTE_LEAD),
      );
    },
    onRefused: (message) => toast.add({ title: message }),
    breaks,
    oneBreak: breakEditing,
    singers: singersView,
  });

  const visibleBreaks = createMemo(() => {
    const from = view().start;
    const to = from + visibleSeconds(view(), width());
    // During a move the breaks are drawn as it would leave them (those going along with a gap too); a break dragged on
    // its own where it would go.
    const moving = editing.drag();
    const dragged = breakEditing.drag();
    return (moving ? lineBreaks(previewChart(chart(), moving)).filter(sungShown) : breaks())
      .map((item) =>
        dragged?.lineId === item.lineId ? Object.assign({}, item, { time: dragged.time, auto: false }) : item,
      )
      .filter((item) => item.time >= from && item.time <= to);
  });
  /** A duet's singers by name, for Sung by (none in a solo chart). */
  const singerLabels = () =>
    duet() ? chart().singers.map((singer) => ({ index: singer.index, label: singerLabel(singer) })) : [];
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
    canChartRange,
    chartRange: openChartRange,
    canAutoPitch: () => canAutoPitch() && selectedNotes().length > 0,
    autoPitch: () => editing.commands.autoPitch(),
    canSplitAtPlayhead: () => editing.commands.canSplitAtPlayhead(),
    splitAtPlayhead: () => editing.commands.splitAtPlayhead(),
    canMerge: () => editing.commands.canMerge(),
    merge: () => editing.commands.merge(),
    lineBreakAfter: () => breakEditing.addAfter(),
    editLineLyrics: () => {
      const first = selectedNotes().toSorted((a, b) => a.start - b.start)[0];
      if (first) lineText.edit(first.lineId);
    },
    singers: singerLabels,
    sungBy: () => editing.commands.sungBy(),
    assign: (index) => editing.commands.assign(index),
    copyTarget: () => {
      const target = editing.commands.copyTarget();
      return target ? singerLabel(target) : null;
    },
    copyToOther: () => editing.commands.copyToOther(),
    flagOn: (flag) => editing.commands.flagOn(flag),
    toggleFlag: (flag) => editing.commands.toggleFlag(flag),
    cut: () => runEditCommand("cut"),
    copy: () => runEditCommand("copy"),
    paste: () => pasteFromClipboard(),
    remove: () => editing.commands.remove(),
    selectAll: () => editing.commands.selectAll(),
  };

  /** Hides or shows singers: what is hidden leaves the selection, so no command acts on notes out of view. */
  const showSingers = (change: () => void) => {
    cancelGestures();
    change();
    flush();
    const ids = new Set(notes().map((note) => note.id));
    const ends = new Set(breaks().map((item) => item.lineId));
    const current = selection();
    setSelection({
      notes: current.notes.filter((id) => ids.has(id)),
      breaks: current.breaks.filter((id) => ends.has(id)),
    });
  };
  /** After undo or redo: what the step selected comes into view, and its singer is made active. */
  const followHistory = () => {
    flush();
    const current = chart();
    const ids = new Set(selection().notes);
    const ends = new Set(selection().breaks);
    const touched = current.singers.filter((singer) =>
      singer.lines.some((line) => ends.has(line.id) || line.notes.some((note) => ids.has(note.id))),
    );
    if (touched.some((singer) => singersView.isHidden(singer.index))) singersView.showAll();
    const singer = singerOf(current, ids);
    if (singer) singersView.choose(singer.index);
  };
  /** Add singer: the second one, made active, its chip ready for a name. */
  const addSecondSinger = (): number | null => {
    cancelGestures();
    const current = chart();
    let id: number | null = null;
    doc().edit("Add singer", (tx) => (id = addSinger(tx, current)));
    const added = id === null ? undefined : chart().singers.find((singer) => singer.id === id);
    if (added) singersView.choose(added.index);
    return id;
  };
  /** Removes a singer, its notes deleted or moved to the other one (`merge`). */
  const removeOneSinger = (id: number, merge: boolean) => {
    const singer = chart().singers.find((item) => item.id === id);
    if (!singer || chartingRange() || autoPitch.busy()) return;
    cancelGestures();
    const current = chart();
    let moved: number[] = [];
    doc().edit(`Remove ${singerLabel(singer)}`, (tx) => (moved = removeSinger(tx, current, id, { merge })), {
      selectionAfter: () => notesOnly(moved),
    });
    singersView.showAll();
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

  const lineText = createLineTextEditing({
    doc,
    chart,
    syllabify: (words) => native.lyrics.syllabify({ language: codeOfLanguage(chart().song.language[0]), words }),
    onRefused: (message) => toast.add({ title: message }),
    onError: (error) => toastError("Couldn't change the lyrics", error),
    beforeEdit: cancelGestures,
  });

  let editArea: HTMLDivElement | undefined;
  let rollArea: HTMLDivElement | undefined;

  /**
   * Makes sure the sung pitch is there: stored ones come at once; otherwise it is worked out now (getting the pitch
   * model first if needed). When the project opens, "Opening the project…" covers the editor meanwhile; for new vocals
   * the editor stays usable and the pitch appears when it's ready. Neither fails on it.
   */
  const preparePitch = async (signal: AbortSignal, opening: boolean) => {
    if (!media("vocals")) return;
    const shown = opening ? setTimeout(() => setOpening((current) => current ?? null), 150) : undefined;
    try {
      const result = await followProgress(
        () => native.project.pitch({ id: overview().id }, { signal }),
        signal,
        (progress) => {
          if (opening) setOpening(progress);
        },
      );
      if (!signal.aborted) setPitch(result);
    } catch (error) {
      if (!signal.aborted) toastError("Couldn't follow the melody", error);
    } finally {
      clearTimeout(shown);
      if (opening && !signal.aborted) setOpening(undefined);
    }
  };

  /** The waveform lane's: stored ones come at once, a new one is worked out in a second or two. */
  const waveformRun = createLatest();
  const loadWaveform = () => {
    const signal = waveformRun.next();
    if (!media("vocals") && !media("audio")) return void setWaveform(null);
    // The old one stays until the new one is there, so the lane doesn't come and go.
    native.project.waveform({ id: overview().id }, { signal }).then(
      (result) => {
        if (!signal.aborted) setWaveform(result);
      },
      // Without it there is just no lane: an audio file that can't be read says so when it plays.
      (error: unknown) => {
        if (!signal.aborted) console.error(error);
      },
    );
  };

  /** Follows the vocals' pitch again (new vocals), stopping the last one. */
  const pitchRun = createLatest();
  const followVocals = (opening = false) => void preparePitch(pitchRun.next(), opening);
  // A replaced song, vocals or music plays from where it was; new vocals have their pitch followed.
  createEffect(playbackUrls, (urls, previous) => {
    if (!previous) return;
    playback.setUrls(urls);
    if (urls.vocals !== previous.vocals) {
      setPitch(null);
      followVocals();
    }
    if (urls.vocals !== previous.vocals || urls.audio !== previous.audio) loadWaveform();
  });

  // Edits still saving are waited for before the window closes, the app quits or the page reloads.
  onSettled(() => setFlushHandler(() => doc().saved()));
  // The File menu (macOS): exports, song details and closing, for this window's project.
  onSettled(() =>
    onMenuCommand((command) => {
      if (command === "export-games") void songExport.forGames();
      else if (command === "export-usdb") void songExport.forUsdb();
      else if (command === "try-in-game") void songExport.tryInGame();
      else if (command === "song-details") setDetailsOpen(true);
      else void close();
    }),
  );

  /**
   * The first view, once there is room and something to show: the first line's start, or (an empty chart) the song's,
   * once its length is known (before, the timeline is a second long). Returns whether it placed it now.
   */
  const placeFirstView = () => {
    const first = lines()[0];
    if (placed || width() <= 0 || (!first && playback.duration() <= 0)) return false;
    placed = true;
    const start = first ? Math.max(0, first.start - 1) : 0;
    setView(fitRange(start, start + FIRST_VIEW_SECONDS, width(), length(), 0));
    return true;
  };
  createEffect(
    () => playback.duration(),
    () => void placeFirstView(),
  );
  // The chart loaded again (a save failed): what pointed into the old one goes (ids, fields being typed in).
  createEffect(doc, (_next, previous) => {
    if (!previous) return;
    cancelGestures();
    editing.finishLyric(null);
    void lineText.finish(null, true);
    setSelection(NOTHING);
  });

  onSettled(() => {
    playback.load();
    const stopKeyHints = listenForKeyHints();
    followVocals(true);
    loadWaveform();
    const observer = new ResizeObserver(() => {
      if (!rollArea) return;
      const next = { width: Math.max(0, rollArea.clientWidth - GUTTER_PX), height: rollArea.clientHeight };
      setSize(next);
      if (!placeFirstView()) setView((current) => clampView(current, next.width, length()));
    });
    if (rollArea) observer.observe(rollArea);

    // Cmd/Ctrl+wheel and pinch (which comes as Ctrl+wheel) zoom at the pointer; other wheel scrolls through time. A
    // trackpad sends several events a frame: they add up, and the view changes once, on the next frame.
    let wheel: { zoom: number; scroll: number; clientX: number } | null = null;
    let wheelFrame = 0;
    const applyWheel = () => {
      wheelFrame = 0;
      if (!wheel) return;
      const { zoom, scroll, clientX } = wheel;
      wheel = null;
      const x = clientX - (editArea?.getBoundingClientRect().left ?? 0) - GUTTER_PX;
      let next = view();
      if (zoom !== 1) next = zoomAt(next, zoom, x, width(), length());
      if (scroll !== 0) next = scrollBy(next, scroll, width(), length());
      changeView(next);
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      wheel ??= { zoom: 1, scroll: 0, clientX: event.clientX };
      wheel.clientX = event.clientX;
      if (event.ctrlKey || event.metaKey) wheel.zoom *= Math.exp(-event.deltaY * 0.01);
      else wheel.scroll += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      wheelFrame ||= requestAnimationFrame(applyWheel);
    };
    editArea?.addEventListener("wheel", onWheel, { passive: false });

    const onKey = (event: KeyboardEvent) => {
      // Typing, a menu or list, or a focused control's own keys (Enter presses a button, a slider's arrows) aren't the
      // editor's.
      if (isTyping(event.target) || inMenu(event.target) || controlKey(event.target, event.key)) return;
      // The right-click menu from the keyboard: the focused control's, else the selected notes'.
      const focused = document.activeElement === document.body ? null : document.activeElement;
      const target = focused ?? document.querySelector('[data-testid="roll-note"][data-selected="true"]');
      if (openContextMenu(event, target)) {
        event.preventDefault();
        return;
      }
      // On macOS the Edit menu takes Cmd+Z; Windows and Linux have no menu bar, so the keys come here.
      const command = event.ctrlKey && !event.altKey && platform !== "macos" ? undoKey(event) : null;
      if (command) {
        event.preventDefault();
        runEditCommand(command);
        return;
      }
      // Try in game: the File menu's on macOS.
      if (
        platform !== "macos" &&
        event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "t"
      ) {
        event.preventDefault();
        void songExport.tryInGame();
        return;
      }
      // Esc: stops a drag first (a loop range or song marker on the ruler here, notes and breaks in their own keys),
      // then goes back to Select, then deselects.
      if (event.key === "Escape" && (loop.busy() || songMarkers.busy())) {
        event.preventDefault();
        loop.cancel();
        songMarkers.cancel();
        return;
      }
      if (event.key === "Escape" && !gestureBusy() && tools.tool() !== "select") {
        tools.setTool("select");
        return;
      }
      if (breakEditing.key(event) || editing.key(event)) {
        event.preventDefault();
        return;
      }
      // During a drag only Esc counts: the tool doesn't change under it.
      if (gestureBusy()) return;
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && tools.keyDown(event)) {
        event.preventDefault();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === " ") {
        event.preventDefault();
        // Held, it doesn't play and pause over and over.
        if (!event.repeat) togglePlay();
      } else if (event.key === "." || event.key === ",") {
        event.preventDefault();
        goToLine(stepLine(lines(), playback.time(), event.key === "." ? 1 : -1));
      } else if (event.key === "?") {
        event.preventDefault();
        openHelp();
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
        followHistory();
      },
      redo: () => {
        cancelGestures();
        doc().redo();
        followHistory();
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
      stopWork();
      observer.disconnect();
      cancelAnimationFrame(wheelFrame);
      editArea?.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
      playback.dispose();
      tones.dispose();
      scrub.dispose();
      singAlong.stop();
      stopKeyHints();
    };
  });

  /** Everything that still reads or writes the project in the background. */
  const stopWork = () => {
    rangeJob.stop();
    autoPitch.stop();
    mediaFiles.stopSeparating();
    pitchRun.abort();
    waveformRun.abort();
  };

  /** Closes the project (its last edits saved) and goes to the start screen, or the settings' `section`. */
  const close = async (section?: string) => {
    // What still reads or writes the project stops before it closes, and the last edits are saved.
    stopWork();
    await doc()
      .saved()
      .catch(() => {});
    await native.project.close({ id: overview().id }).catch((error: unknown) => console.error(error));
    void navigate(section ? { to: "/settings", hash: section } : { to: "/" });
  };

  const songExport = createSongExport({
    project: () => overview().id,
    song: () => chart().song,
    saved: () => doc().saved(),
    // The editor has no way to the settings but closing the project (it is in the recent projects).
    openGameSettings: () => void close("games"),
  });
  onSettled(() => songExport.refreshGames());

  return (
    <div class="flex h-dvh min-h-0 flex-col overflow-hidden bg-background" data-testid="project">
      <TitleBar
        start={
          <>
            <HistoryButton
              label={doc().undoLabel()}
              action="Undo"
              shortcut={keyOf("undo")}
              onClick={() => runEditCommand("undo")}
              testid="undo"
            >
              <Undo2Icon />
            </HistoryButton>
            <HistoryButton
              label={doc().redoLabel()}
              action="Redo"
              shortcut={keyOf("redo")}
              onClick={() => runEditCommand("redo")}
              testid="redo"
            >
              <Redo2Icon />
            </HistoryButton>
            <ToolSwitch class="mx-3" tool={tools.tool()} onTool={tools.setTool} />
            <AutoPitchButton
              status={autoPitch.busy() ? (autoPitch.progress()?.step ?? null) : undefined}
              percent={percentOf(autoPitch.progress() ?? null) ?? null}
              canStart={canAutoPitch() && selectedNotes().length > 0}
              onStart={() => editing.commands.autoPitch()}
              onStop={() => autoPitch.stop()}
            />
            <ChartRangeButton canStart={canChartRange()} onStart={openChartRange} />
            <MergeButton canMerge={editing.commands.canMerge()} onMerge={() => editing.commands.merge()} />
            <LineBreakButton onAdd={() => breakEditing.addHere()} />
            <Show when={duet() && selectedNotes().length > 0}>
              <SungBySwitch
                singers={singerLabels()}
                sungBy={editing.commands.sungBy()}
                onAssign={(index) => editing.commands.assign(index)}
              />
            </Show>
          </>
        }
      >
        <div class="mr-auto flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            class="flex max-w-[420px] min-w-0 cursor-pointer items-baseline gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] hover:bg-sage-20"
            title="Song details"
            onClick={() => setDetailsOpen(true)}
            data-testid="open-song-details"
          >
            <h1 class="m-0 truncate text-[12.5px] font-medium text-foreground">{chart().song.title || "Untitled"}</h1>
            <span class="truncate text-muted-foreground">· {chart().song.artist || "Unknown artist"}</span>
          </button>
          <ProblemsMenu problems={problems()} onShow={showProblem} />
        </div>

        <IconButton label="Help" shortcut={keyOf("help")} onClick={openHelp} testid="help-open">
          <CircleHelpIcon />
        </IconButton>
        <ExportMenu
          busy={songExport.exporting()}
          games={songExport.available()}
          shortcutGame={songExport.defaultGame()}
          tryShortcut={keyOf("tryInGame")}
          onSongFolder={() => void songExport.forGames()}
          onUsdb={() => void songExport.forUsdb()}
          onTryInGame={(game) => void songExport.tryInGame(game)}
          onOpen={() => songExport.refreshGames()}
        />
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
            duet={bothShown()}
            activeSinger={activeSinger()}
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
              onResetTiming={(item) => breakEditing.resetTiming(item)}
              activeSinger={activeSinger()}
            />
            <div ref={(element) => (rollArea = element)} class="flex min-h-0 flex-1">
              <NoteMenu actions={noteMenu}>
                <PianoRoll
                  onNoteContextMenu={(note) => (menuNote = note)}
                  notes={visibleNotes()}
                  activeSinger={activeSinger()}
                  breaks={visibleBreaks()}
                  range={range()}
                  view={view()}
                  grid={{ start: chart().gap, step: gridStep(chart()) }}
                  width={width()}
                  height={size().height}
                  pitch={prefs.pitch() ? pitch() : null}
                  voice={singAlong.voice()}
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
                    clickSeek(seconds);
                  }}
                  onBox={(area, add) => editing.box(area, add)}
                  tool={tools.tool()}
                  onDrawDown={(at, event, scale) => editing.drawDown(event, at, scale)}
                  drawing={editing.drawing()}
                  onEmptyDoubleClick={(at) => {
                    undoClickSeek();
                    editing.emptyDoubleClick(at);
                  }}
                  cut={editing.cut()}
                  onHover={(note, seconds) => editing.hover(note, seconds)}
                  onSplit={(note, seconds, every) => editing.splitAt(note, seconds, every)}
                  onNoteDoubleClick={(note) => editing.noteDoubleClick(note)}
                  editingLyric={editing.editingLyric()}
                  lyricNote={notes().find((note) => note.id === editing.editingLyric()) ?? null}
                  onLyricDone={(text, move) => editing.finishLyric(text, move)}
                  autoScroll={autoScroll}
                  playhead={playback.time()}
                  onPlayheadDrag={scrubTo}
                  onPlayheadDragEnd={() => scrub.end()}
                />
              </NoteMenu>
            </div>
            <Show when={prefs.waveform() && waveform()}>
              {(shown) => <WaveformLane waveform={shown()} view={view()} width={width()} />}
            </Show>
            <LyricsLane
              lines={visibleLines()}
              all={lines()}
              view={view()}
              duet={bothShown()}
              activeSinger={activeSinger()}
              width={width()}
              editing={lineText.editing()}
              onEdit={lineText.edit}
              onEditDone={(text, fromKey) => void lineText.finish(text, fromKey)}
            />
            <Show when={prefs.video() && media("video")}>
              {(url) => (
                <VideoPreview
                  url={url()}
                  time={playback.time()}
                  playing={playback.playing()}
                  speed={playback.speed()}
                  offset={chart().song.videoGap}
                  onClose={() => prefs.setVideo(false)}
                />
              )}
            </Show>
            <Show when={opening() !== undefined}>
              <OpeningOverlay progress={opening() ?? null} />
            </Show>
            <Playhead
              view={view()}
              width={width()}
              time={playback.time()}
              onScrub={scrubTo}
              onScrubEnd={() => scrub.end()}
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
        onPlay={togglePlay}
        length={length()}
        onZoom={(factor) => changeView(zoomAt(view(), factor, width() / 2, width(), length()))}
        showPitch={pitch() ? prefs.pitch() : undefined}
        onShowPitch={prefs.setPitch}
        showWaveform={waveform() ? prefs.waveform() : undefined}
        onShowWaveform={prefs.setWaveform}
        singAlong={singAlong.on()}
        onSingAlong={toggleSingAlong}
        showVideo={media("video") ? prefs.video() : undefined}
        onShowVideo={prefs.setVideo}
        looping={loop.on()}
        onLoop={toggleLoop}
        following={prefs.following()}
        onFollow={changeFollowing}
        tones={prefs.tones()}
        onTones={prefs.setTones}
        volumes={prefs.volumes()}
        onVolume={prefs.setVolume}
        singers={
          <SingerSwitch
            singers={chart().singers}
            active={singersView.index()}
            isHidden={singersView.isHidden}
            busy={!!chartingRange() || autoPitch.busy()}
            onChoose={(index) => singersView.choose(index)}
            onHidden={(index, hide) => showSingers(() => singersView.setHidden(index, hide))}
            onSolo={(index) => showSingers(() => singersView.solo(index))}
            onShowAll={() => singersView.showAll()}
            onAdd={addSecondSinger}
            onRename={(id, name) => doc().edit("Rename singer", (tx) => tx.updateSinger(id, { name }))}
            onRemove={removeOneSinger}
          />
        }
      />

      <Show when={chartingRange()}>
        {(chosen) => (
          <ChartRangeDialog
            chart={chart()}
            project={overview().id}
            range={chosen().range}
            singerId={chosen().singerId}
            duration={Math.min(
              projectMedia().find((item) => item.role === "vocals")?.duration ?? Infinity,
              playback.duration() || Infinity,
            )}
            job={rangeJob}
            onClose={() => setChartingRange(null)}
          />
        )}
      </Show>
      <HelpDialog open={helpOpen()} onOpenChange={setHelpOpen} />
      <SongDetails
        open={detailsOpen()}
        onOpenChange={setDetailsOpen}
        doc={doc()}
        chart={chart()}
        media={projectMedia()}
        artwork={mediaFiles.artwork}
        songMedia={mediaFiles.files}
        markers={songMarkers}
        selectedLines={() => {
          const chosen = new Set(selectedNotes().map((note) => note.lineId));
          return lines().filter((line) => chosen.has(line.id));
        }}
        playheadTime={() => playback.time()}
        audioLength={editingLength}
        onPlayFrom={(seconds) => {
          seek(seconds);
          playback.play();
        }}
        lyrics={overview().lyrics?.lines}
      />

      <ReplaceExportDialog
        target={songExport.replacing()}
        onCancel={songExport.cancelReplace}
        onReplace={(folder) => songExport.replace(folder)}
      />
    </div>
  );
}

/** Over the editor while opening finishes: what is being prepared, and how far it is. */
function OpeningOverlay(props: { progress: Progress | null }) {
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
        <ProgressBar label="Opening progress" value={percentOf(props.progress)} />
      </div>
    </div>
  );
}
