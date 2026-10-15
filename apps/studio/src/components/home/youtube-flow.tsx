import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import CheckIcon from "~icons/lucide/check";
import LoaderCircleIcon from "~icons/lucide/loader-circle";
import YoutubeIcon from "~icons/lucide/youtube";

import { Button } from "~/components/ui/button";
import { DialogBody, DialogClose, DialogFooter } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { toast } from "~/components/ui/toast";
import { formatDuration, formatFileSize } from "~/lib/format";
import { native } from "~/lib/native/client";
import { type CoverChoice, LONGEST_SONG_SECONDS, type ProjectLyrics } from "~/lib/native/contract";
import { errorMessage, isAbort } from "~/lib/native/errors";
import type {
  ChosenImage,
  CoverCandidate,
  DownloadedDraft,
  FoundLyrics,
  ImportProgress,
  ModelStatus,
  OpenedProject,
  YoutubeVideo,
} from "~/lib/native/types";
import { AUDIO_FORMAT_LABELS, type Settings, VIDEO_FORMAT_LABELS } from "~/lib/settings";

import { CoverPicker, type CoverSelection } from "./cover-picker";
import {
  hasFound,
  type HeardLanguage,
  type Listening,
  type LyricsSearch,
  type LyricsSource,
  LyricsReview,
} from "./lyrics-review";
import { Note } from "./song-import-flow";
import { ToolsStep } from "./tools-step";

/** The steps a YouTube project goes through, as the dialog's header lists them. */
export const YOUTUBE_STEPS = ["Song", "Download", "Lyrics"];

type State =
  | { step: "tools" }
  | { step: "looking" }
  | { step: "lookup-failed"; message: string }
  | { step: "song"; video: YoutubeVideo }
  | { step: "downloading"; video: YoutubeVideo; progress: ImportProgress | null }
  | { step: "download-failed"; video: YoutubeVideo; message: string }
  | { step: "lyrics"; video: YoutubeVideo; draft: DownloadedDraft; error?: string }
  | { step: "saving"; video: YoutubeVideo; draft: DownloadedDraft; progress: ImportProgress | null };

/** Which header step a state belongs to. */
function stepIndex(step: State["step"]): number {
  if (step === "downloading" || step === "download-failed") return 1;
  if (step === "lyrics" || step === "saving") return 2;
  return 0;
}

/** What the settings will download, in a few words. */
export function describeDownload(settings: Settings): string {
  const audio =
    settings.audio.format === "m4a" || settings.audio.format === "opus"
      ? AUDIO_FORMAT_LABELS[settings.audio.format]
      : `${AUDIO_FORMAT_LABELS[settings.audio.format]} ${settings.audio.bitrate} kbps`;
  if (!settings.video.download) return `Audio as ${audio}, without the video`;
  return `Audio as ${audio}, video as ${VIDEO_FORMAT_LABELS[settings.video.format]} up to ${settings.video.maxResolution}p`;
}

/**
 * The download step's checklist, in the order main reports it. The voice separation model is
 * downloaded the first time only.
 */
export function downloadTasks(settings: Settings | null, models: ModelStatus | null): string[] {
  return [
    "Downloading the audio",
    ...(settings?.video.download === false ? [] : ["Downloading the video"]),
    ...(settings && settings.audio.normalization !== "off" ? ["Adjusting the volume"] : []),
    ...(models && !models.separation ? ["Getting the voice separation model"] : []),
    "Separating the voice",
  ];
}

/** How long typing in artist or title pauses before covers are searched again. */
const SEARCH_DELAY = 600;

/**
 * A new project from a YouTube video, step by step: the song's details and cover, the download,
 * then the lyrics; "Create project" asks where to save and writes the project. Until then
 * everything lives in a draft that is thrown away when the dialog closes.
 */
export function YoutubeFlow(props: {
  videoId: string;
  url: string;
  /** False once the dialog closes. */
  open: boolean;
  header: (step: number) => JSX.Element;
  onOpened: (project: OpenedProject) => void;
}) {
  const [state, setState] = createSignal<State>({ step: "tools" });
  const [artist, setArtist] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [settings, setSettings] = createSignal<Settings | null>(null);
  /** Which models are downloaded, checked when the download starts. */
  const [models, setModels] = createSignal<ModelStatus | null>(null);
  /** Found covers, or null while searching. */
  const [covers, setCovers] = createSignal<CoverCandidate[] | null>(null);
  /** The chosen cover: the video's thumbnail until the user picks another. */
  const [cover, setCover] = createSignal<CoverSelection>({ kind: "thumbnail" });
  /** An image the user picked from their files. */
  const [customCover, setCustomCover] = createSignal<ChosenImage | null>(null);
  const [lyricsSearch, setLyricsSearch] = createSignal<LyricsSearch>({ status: "searching" });
  const [lyricsSource, setLyricsSource] = createSignal<LyricsSource>("found");
  /** The user chose the source: a new search no longer switches it. */
  let lyricsSourcePicked = false;
  const [ownLyrics, setOwnLyrics] = createSignal("");
  const [listening, setListening] = createSignal<Listening>({ status: "idle" });
  let listenController: AbortController | undefined;
  /** The artist and title the lyrics were last looked up for. */
  let lyricsFor = "";
  /** The downloaded draft, kept when going back; discarded when the dialog closes without saving. */
  let draft: DownloadedDraft | undefined;
  let saved = false;
  let controller: AbortController | undefined;
  /** The dialog closed: work still finishing is thrown away. */
  let disposed = false;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let coverSearch = 0;
  let lyricsSearchCount = 0;

  const video = () => {
    const value = state();
    return "video" in value ? value.video : undefined;
  };

  /** Searches covers for a song; only the latest search's answer counts. */
  const searchCovers = async (found: YoutubeVideo, song: { artist: string; title: string }) => {
    const search = ++coverSearch;
    setCovers(null);
    const results = await native.youtube
      .findCovers({ artist: song.artist.trim(), title: song.title.trim(), duration: found.duration })
      .catch((): CoverCandidate[] => []);
    if (search !== coverSearch) return;
    setCovers(results);
    // The thumbnail stays chosen until the user picks a cover; a picked one that a new search
    // no longer offers falls back to it.
    const selection = cover();
    if (selection.kind === "found" && !results.some((candidate) => candidate.url === selection.url)) {
      setCover({ kind: "thumbnail" });
    }
  };

  /**
   * Searches covers again after artist or title changed (and typing paused). The covers found
   * for the old details are dropped at once, so none of them can be saved with the new ones.
   */
  const searchCoversSoon = () => {
    clearTimeout(searchTimer);
    coverSearch++;
    setCovers(null);
    const found = video();
    if (found) {
      searchTimer = setTimeout(() => void searchCovers(found, { artist: artist(), title: title() }), SEARCH_DELAY);
    }
  };

  /** Looks the lyrics up for the current artist and title; found lyrics fill the text unless the user wrote their own. */
  const searchLyrics = async (found: YoutubeVideo) => {
    const search = ++lyricsSearchCount;
    lyricsFor = `${artist().trim()}\n${title().trim()}`;
    setLyricsSearch({ status: "searching" });
    let result: FoundLyrics | null;
    try {
      result = await native.youtube.findLyrics({
        artist: artist().trim(),
        title: title().trim(),
        duration: found.duration,
      });
    } catch (error) {
      if (search === lyricsSearchCount) setLyricsSearch({ status: "failed", message: errorMessage(error) });
      return;
    }
    if (search !== lyricsSearchCount) return;
    const done: LyricsSearch = { status: "done", found: result };
    setLyricsSearch(done);
    // Nothing online: listening to the song is the next best thing (it starts on request).
    if (!lyricsSourcePicked) setLyricsSource(hasFound(done) ? "found" : "heard");
  };

  /** What Whisper hears in the downloaded song, in the languages asked for. */
  const listen = async (heard: HeardLanguage) => {
    if (!draft) return;
    listenController?.abort();
    const current = new AbortController();
    listenController = current;
    setListening({ status: "listening", progress: null });
    try {
      const iterator = await native.youtube.listen({ draftId: draft.draftId, ...heard }, { signal: current.signal });
      for (;;) {
        const next = await iterator.next();
        if (current !== listenController) return;
        if (next.done) {
          setListening({ status: "done", heard: next.value });
          return;
        }
        setListening({ status: "listening", progress: next.value });
      }
    } catch (error) {
      if (current !== listenController || isAbort(error) || current.signal.aborted) return;
      setListening({ status: "failed", message: errorMessage(error), request: heard });
    }
  };

  /** What main is told about the lyrics: LRCLIB's with their timing, the user's own without, or none. */
  const projectLyrics = (): ProjectLyrics | null => {
    const search = lyricsSearch();
    const heard = listening();
    if (lyricsSource() === "heard") {
      return heard.status === "done" && heard.heard.lines.length > 0
        ? {
            source: "whisper",
            language: heard.heard.language,
            ...(heard.heard.mixed ? { mixed: true } : {}),
            lines: heard.heard.lines.map((line) => ({ start: line.start, text: line.text })),
          }
        : null;
    }
    if (lyricsSource() === "found") {
      return search.status === "done" && search.found && search.found.lines.length > 0
        ? { source: "lrclib", lrclibId: search.found.id, lines: search.found.lines }
        : null;
    }
    const lines = ownLyrics()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((text) => ({ start: null, text }));
    return lines.length > 0 ? { source: "user", lines } : null;
  };

  /**
   * Where year and genre come from: the best match that is surely this song, whichever cover is
   * chosen (they describe the song, not the picture).
   */
  const songSource = () => covers()?.find((candidate) => candidate.confident) ?? null;

  /**
   * What main is told about the cover. A found cover counts only while the current search
   * offers it: after artist or title changed, the old pick waits for the new search, and saving
   * before that answers uses the thumbnail.
   */
  const coverChoice = (): CoverChoice => {
    const selection = cover();
    if (selection.kind === "found" && !covers()?.some((candidate) => candidate.url === selection.url)) {
      return { kind: "thumbnail" };
    }
    return selection.kind === "file" ? { kind: "file", path: selection.image.path } : selection;
  };

  const chooseCoverFile = async () => {
    try {
      const image = await native.dialogs.chooseCoverImage();
      if (!image) return;
      setCustomCover(image);
      setCover({ kind: "file", image });
    } catch (error) {
      toast.add({ type: "error", title: "Couldn't use this image", description: errorMessage(error) });
    }
  };

  const lookUp = async () => {
    setState({ step: "looking" });
    try {
      const found = await native.youtube.inspect({ videoId: props.videoId });
      setArtist(found.artist);
      setTitle(found.songTitle);
      setState({ step: "song", video: found });
      // Signals written just now still read their old value, so the search gets the details directly.
      void searchCovers(found, { artist: found.artist, title: found.songTitle });
    } catch (error) {
      setState({ step: "lookup-failed", message: errorMessage(error) });
    }
  };

  /** The lyrics step: looks the lyrics up again only when artist or title changed since. */
  const showLyrics = (found: YoutubeVideo, downloaded: DownloadedDraft) => {
    setState({ step: "lyrics", video: found, draft: downloaded });
    if (lyricsFor !== `${artist().trim()}\n${title().trim()}`) void searchLyrics(found);
  };

  /** Downloads the song into a draft (once; going back and on keeps it), then shows the lyrics. */
  const download = async (found: YoutubeVideo) => {
    if (draft) {
      showLyrics(found, draft);
      return;
    }
    controller = new AbortController();
    setState({ step: "downloading", video: found, progress: null });
    try {
      setModels(await native.models.status().catch(() => null));
      const iterator = await native.youtube.download({ videoId: found.videoId }, { signal: controller.signal });
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          // The dialog closed while the download finished: nobody will use this draft.
          if (disposed) {
            native.drafts.discard({ draftId: next.value.draftId }).catch(() => {});
            return;
          }
          draft = next.value;
          showLyrics(found, next.value);
          return;
        }
        setState({ step: "downloading", video: found, progress: next.value });
      }
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) setState({ step: "song", video: found });
      else setState({ step: "download-failed", video: found, message: errorMessage(error) });
    } finally {
      controller = undefined;
    }
  };

  const create = async (found: YoutubeVideo, downloaded: DownloadedDraft) => {
    let target: string | null;
    try {
      target = await native.dialogs.chooseProjectLocation({ name: `${artist().trim()} - ${title().trim()}` });
    } catch (error) {
      setState({ step: "lyrics", video: found, draft: downloaded, error: errorMessage(error) });
      return;
    }
    if (!target) return;
    controller = new AbortController();
    setState({ step: "saving", video: found, draft: downloaded, progress: null });
    try {
      const iterator = await native.youtube.create(
        {
          draftId: downloaded.draftId,
          artist: artist().trim(),
          title: title().trim(),
          year: songSource()?.year ?? found.year,
          genre: songSource()?.genre ?? null,
          cover: coverChoice(),
          lyrics: projectLyrics(),
          target,
        },
        { signal: controller.signal },
      );
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          saved = true;
          props.onOpened(next.value);
          return;
        }
        setState({ step: "saving", video: found, draft: downloaded, progress: next.value });
      }
    } catch (error) {
      const message = isAbort(error) || controller.signal.aborted ? undefined : errorMessage(error);
      setState({ step: "lyrics", video: found, draft: downloaded, error: message });
    } finally {
      controller = undefined;
    }
  };

  onSettled(() => {
    native.settings
      .get()
      .then(setSettings)
      .catch(() => {});
    return () => {
      disposed = true;
      controller?.abort();
      listenController?.abort();
      clearTimeout(searchTimer);
      // A closed dialog leaves nothing behind.
      if (draft && !saved) native.drafts.discard({ draftId: draft.draftId }).catch(() => {});
    };
  });

  createEffect(
    () => props.open,
    (open) => {
      if (!open) controller?.abort();
    },
  );

  const busy = () => state().step === "downloading" || state().step === "saving";
  const tooLong = () => (video()?.duration ?? 0) > LONGEST_SONG_SECONDS;
  const canContinue = () => state().step === "song" && artist().trim() !== "" && title().trim() !== "" && !tooLong();
  const of = <K extends State["step"]>(step: K) => {
    const value = state();
    return value.step === step ? (value as Extract<State, { step: K }>) : undefined;
  };

  return (
    <>
      {props.header(stepIndex(state().step))}
      <DialogBody aria-busy={state().step === "looking" || busy() ? "true" : "false"}>
        <Show
          when={video()}
          fallback={
            <div class="flex items-center gap-3 rounded-[10px] border border-popover-line bg-popover-well/50 p-3">
              <span class="flex size-9 shrink-0 items-center justify-center rounded-md bg-youtube-soft text-youtube">
                <YoutubeIcon class="size-4" />
              </span>
              <span class="min-w-0 truncate font-mono text-[10.5px] text-popover-muted" title={props.url}>
                {props.url}
              </span>
            </div>
          }
        >
          {(found) => <VideoCard video={found()} />}
        </Show>

        <Switch>
          <Match when={state().step === "tools"}>
            <ToolsStep onReady={() => void lookUp()} />
          </Match>
          <Match when={state().step === "looking"}>
            <p class="m-0 flex items-center gap-2 text-[11.5px] text-popover-foreground" aria-live="polite">
              <LoaderCircleIcon class="size-4 animate-spin text-primary" />
              Looking up the video…
            </p>
          </Match>
          <Match when={of("lookup-failed")}>
            {(failed) => (
              <Note tone="error" testid="youtube-error">
                {failed().message}
              </Note>
            )}
          </Match>
          <Match when={state().step === "song"}>
            <div class="grid grid-cols-2 gap-3">
              <Label layout="stacked">
                Artist
                <Input
                  value={artist()}
                  onInput={(event) => {
                    setArtist(event.currentTarget.value);
                    searchCoversSoon();
                  }}
                  data-testid="youtube-artist"
                />
              </Label>
              <Label layout="stacked">
                Title
                <Input
                  value={title()}
                  onInput={(event) => {
                    setTitle(event.currentTarget.value);
                    searchCoversSoon();
                  }}
                  data-testid="youtube-title"
                />
              </Label>
            </div>
            <CoverPicker
              covers={covers()}
              thumbnail={video()?.thumbnail ?? null}
              custom={customCover()}
              selected={cover()}
              onSelect={setCover}
              onChooseFile={() => void chooseCoverFile()}
            />
            <Show when={tooLong()}>
              <Note tone="error" testid="youtube-too-long">
                This video is longer than {LONGEST_SONG_SECONDS / 60} minutes, too long for a song. Choose the song's
                own video.
              </Note>
            </Show>
            <Show when={settings()}>
              {(current) => (
                <p class="m-0 text-[10.5px] text-popover-muted" data-testid="youtube-download-summary">
                  {describeDownload(current())}. You can change this in Settings.
                </p>
              )}
            </Show>
          </Match>
          <Match when={of("downloading")}>
            {(downloading) => (
              <DownloadChecklist tasks={downloadTasks(settings(), models())} progress={downloading().progress} />
            )}
          </Match>
          <Match when={of("download-failed")}>
            {(failed) => (
              <Note tone="error" testid="youtube-error">
                {failed().message}
              </Note>
            )}
          </Match>
          <Match when={state().step === "lyrics" || state().step === "saving"}>
            <LyricsReview
              search={lyricsSearch()}
              listening={listening()}
              listeningModelMissing={models()?.whisper === false}
              source={lyricsSource()}
              ownText={ownLyrics()}
              videoDuration={video()?.duration ?? null}
              disabled={state().step === "saving"}
              onSource={(source) => {
                lyricsSourcePicked = true;
                setLyricsSource(source);
              }}
              onOwnText={(text) => {
                // Editing found or heard lyrics makes them the user's own; the originals stay as they were.
                lyricsSourcePicked = true;
                setOwnLyrics(text);
                setLyricsSource("own");
              }}
              onRetry={() => {
                const found = video();
                if (found) void searchLyrics(found);
              }}
              onListen={(heard) => void listen(heard)}
            />
            <Show when={of("saving")}>{(saving) => <SaveProgress progress={saving().progress} />}</Show>
            <Show when={of("lyrics")?.error}>
              {(message) => (
                <Note tone="error" testid="youtube-error">
                  {message()}
                </Note>
              )}
            </Show>
          </Match>
        </Switch>
      </DialogBody>
      <DialogFooter class="items-center">
        <Show when={of("download-failed") ?? of("lyrics")}>
          {(current) => (
            <Button
              variant="outline"
              class="mr-auto"
              onClick={() => setState({ step: "song", video: current().video })}
              data-testid="youtube-back"
            >
              Back
            </Button>
          )}
        </Show>
        <DialogClose
          render={(closeProps: JSX.HTMLAttributes<HTMLButtonElement>) => <Button variant="outline" {...closeProps} />}
        >
          Cancel
        </DialogClose>
        <Switch
          fallback={
            <Button
              disabled={!canContinue()}
              onClick={() => {
                const found = video();
                if (found) void download(found);
              }}
              data-testid="youtube-next"
            >
              <Show when={state().step === "downloading"}>
                <LoaderCircleIcon class="animate-spin" />
              </Show>
              Next
            </Button>
          }
        >
          <Match when={state().step === "lookup-failed"}>
            <Button onClick={() => void lookUp()}>Try again</Button>
          </Match>
          <Match when={of("download-failed")}>
            {(failed) => <Button onClick={() => void download(failed().video)}>Try again</Button>}
          </Match>
          <Match when={of("lyrics") ?? of("saving")}>
            {(current) => (
              <Button
                disabled={
                  state().step === "saving" ||
                  (lyricsSource() === "found" && lyricsSearch().status === "searching") ||
                  // Saving removes the draft that listening still reads from.
                  listening().status === "listening"
                }
                onClick={() => void create(current().video, current().draft)}
                data-testid="youtube-create"
              >
                <Show when={state().step === "saving"}>
                  <LoaderCircleIcon class="animate-spin" />
                </Show>
                Create project…
              </Button>
            )}
          </Match>
        </Switch>
      </DialogFooter>
    </>
  );
}

function VideoCard(props: { video: YoutubeVideo }) {
  return (
    <div
      class="flex items-center gap-3 rounded-[10px] border border-popover-line bg-popover-well/50 p-2.5"
      data-testid="youtube-video"
    >
      <Show
        when={props.video.thumbnail}
        fallback={
          <span class="flex aspect-video w-[112px] shrink-0 items-center justify-center rounded-md bg-youtube-soft text-youtube">
            <YoutubeIcon class="size-5" />
          </span>
        }
      >
        {(thumbnail) => (
          <img src={thumbnail()} alt="" class="aspect-video w-[112px] shrink-0 rounded-md object-cover" />
        )}
      </Show>
      <div class="flex min-w-0 flex-col gap-1">
        <span class="line-clamp-2 text-[12px] leading-snug font-medium text-foreground" title={props.video.title}>
          {props.video.title}
        </span>
        <span class="truncate text-[10.5px] text-popover-muted">
          {props.video.channel}
          <Show when={props.video.duration}>{(duration) => <> · {formatDuration(duration())}</>}</Show>
        </span>
      </div>
    </div>
  );
}

const progressBarClass =
  "h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-sage-22 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-150";

const percentOf = (progress: ImportProgress | null) =>
  progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : undefined;

/** The download step: each task ticked off as main moves past it, the current one with its progress. */
function DownloadChecklist(props: { tasks: string[]; progress: ImportProgress | null }) {
  const current = () => Math.max(0, props.tasks.indexOf(props.progress?.step ?? props.tasks[0]!));
  return (
    <div class="flex flex-col gap-1">
      <p class="m-0 text-[13px] font-semibold text-foreground">Downloading the song</p>
      <p class="m-0 mb-2 text-[11px] text-popover-muted">This takes a minute or two. The lyrics come next.</p>
      <ol
        aria-label="Download"
        class="m-0 flex list-none flex-col gap-3 rounded-[10px] border border-popover-line bg-popover-well/50 p-3.5"
        data-testid="youtube-progress"
      >
        <For each={props.tasks}>
          {(task, index) => (
            <li
              data-state={index() < current() ? "done" : index() === current() ? "active" : "waiting"}
              class="flex items-start gap-2.5 text-[11.5px] text-popover-foreground data-[state=waiting]:text-popover-muted"
            >
              <span class="mt-px flex size-4 shrink-0 items-center justify-center">
                <Switch fallback={<span class="size-4 rounded-full border border-popover-line" />}>
                  <Match when={index() < current()}>
                    <span class="flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <CheckIcon class="size-3" stroke-width={3} />
                    </span>
                  </Match>
                  <Match when={index() === current()}>
                    {/* The icon's ring is 18 of its 24 units: at 21px it is as wide as the 16px ticks. */}
                    <LoaderCircleIcon class="size-[21px] shrink-0 animate-spin text-primary" />
                  </Match>
                </Switch>
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                <span class="flex items-baseline justify-between gap-3">
                  {task}
                  <Show when={index() === current() && props.progress && props.progress.total > 0}>
                    <span class="font-mono text-[10.5px] text-popover-muted tabular-nums">
                      {props.progress?.unit === "percent"
                        ? `${percentOf(props.progress)}%`
                        : `${formatFileSize(props.progress?.done ?? 0)} of ${formatFileSize(props.progress?.total ?? 0)}`}
                    </span>
                  </Show>
                </span>
                <Show when={index() === current()}>
                  <progress
                    aria-label={`${task} progress`}
                    max="100"
                    value={percentOf(props.progress)}
                    class={progressBarClass}
                  />
                </Show>
              </div>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

/** Saving the project at the end: what is being written. */
function SaveProgress(props: { progress: ImportProgress | null }) {
  return (
    <div class="flex flex-col gap-2" data-testid="youtube-save-progress">
      <span class="text-[11px] text-popover-foreground" aria-live="polite">
        {props.progress?.step ?? "Saving the project"}…
      </span>
      <progress aria-label="Saving progress" max="100" value={percentOf(props.progress)} class={progressBarClass} />
    </div>
  );
}
