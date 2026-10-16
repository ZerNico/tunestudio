import { createSignal, onSettled } from "solid-js";

import { toast } from "~/components/ui/toast";
import { chartInputsKey } from "~/lib/chart-inputs";
import { guessLyricsLanguage } from "~/lib/lyrics-language";
import { native } from "~/lib/native/client";
import type { CoverChoice, ProjectLyrics } from "~/lib/native/contract";
import { errorMessage, isAbort } from "~/lib/native/errors";
import type {
  ChosenImage,
  CoverCandidate,
  DownloadedDraft,
  FoundLyrics,
  MadeChart,
  ModelStatus,
} from "~/lib/native/types";
import type { Settings } from "~/lib/settings";

import { chartUnavailable } from "./chart-choice";
import type { CoverSelection } from "./cover-picker";
import { hasFound, type HeardLanguage, type Listening, type LyricsSearch, type LyricsSource } from "./lyrics-review";

/** How long typing in artist or title pauses before covers are searched again. */
const SEARCH_DELAY = 600;

/** What the source knows about the song before the user changes anything. */
export interface SongBasis {
  artist: string;
  title: string;
  /** Seconds, to tell versions apart when looking for lyrics and covers. */
  duration: number | null;
  year: number | null;
  /** The language the source says it is in (ISO 639-1), or null. */
  language: string | null;
}

/**
 * Everything a new project collects on its way through the stages, whatever its song came from: the song's details,
 * cover and language, the draft the song was put into, the lyrics, and the chart. The draft is thrown away when the
 * flow goes away without saving.
 */
export function createNewProject() {
  const [basis, setBasis] = createSignal<SongBasis | null>(null);
  const [artist, setArtist] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [settings, setSettings] = createSignal<Settings | null>(null);
  /** Which models are downloaded, checked when the song is downloaded. */
  const [models, setModels] = createSignal<ModelStatus | null>(null);
  /** Found covers, or null while searching. */
  const [covers, setCovers] = createSignal<readonly CoverCandidate[] | null>(null);
  /** The chosen cover: the source's own picture until the user picks another. */
  const [cover, setCover] = createSignal<CoverSelection>({ kind: "thumbnail" });
  /** An image the user picked from their files. */
  const [customCover, setCustomCover] = createSignal<ChosenImage | null>(null);
  /** The language the user chose (null: "don't know"); undefined while the suggested one stands. */
  const [pickedLanguage, setPickedLanguage] = createSignal<string | null | undefined>(undefined);
  const [lyricsSearch, setLyricsSearch] = createSignal<LyricsSearch>({ status: "searching" });
  const [lyricsSource, setLyricsSource] = createSignal<LyricsSource>("found");
  const [ownLyrics, setOwnLyrics] = createSignal("");
  const [listening, setListening] = createSignal<Listening>({ status: "idle" });
  const [makeChart, setMakeChart] = createSignal(true);
  /** The chart made for the draft, kept when going back. */
  const [madeChart, setMadeChart] = createSignal<MadeChart | null>(null);
  const [draft, setDraft] = createSignal<DownloadedDraft | null>(null);
  /** The user chose the lyrics source: a new search no longer switches it. */
  let lyricsSourcePicked = false;
  /** The artist and title the lyrics were last looked up for. */
  let lyricsFor = "";
  let listenController: AbortController | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let coverSearch = 0;
  let lyricsSearchCount = 0;
  let saved = false;
  /** The flow went away: work still finishing is thrown away. */
  let disposed = false;
  /** The draft as soon as it exists (signals written just now still read their old value). */
  let currentDraft: DownloadedDraft | null = null;

  onSettled(() => {
    native.settings
      .get()
      .then(setSettings)
      .catch(() => {});
    return () => {
      disposed = true;
      listenController?.abort();
      clearTimeout(searchTimer);
      // A closed dialog leaves nothing behind.
      if (currentDraft && !saved) native.drafts.discard({ draftId: currentDraft.draftId }).catch(() => {});
    };
  });

  /** Searches covers for a song; only the latest search's answer counts. */
  const searchCovers = async (song: { artist: string; title: string; duration: number | null }) => {
    const search = ++coverSearch;
    setCovers(null);
    const results = await native.youtube
      .findCovers({ artist: song.artist.trim(), title: song.title.trim(), duration: song.duration })
      .catch((): readonly CoverCandidate[] => []);
    if (search !== coverSearch) return;
    setCovers(results);
    // The source's picture stays chosen until the user picks a cover; a picked one that a new search no longer
    // offers falls back to it.
    const selection = cover();
    if (selection.kind === "found" && !results.some((candidate) => candidate.url === selection.url)) {
      setCover({ kind: "thumbnail" });
    }
  };

  /**
   * Searches covers again after artist or title changed (and typing paused). The covers found for the old details are
   * dropped at once, so none of them can be saved with the new ones.
   */
  const searchCoversSoon = () => {
    clearTimeout(searchTimer);
    coverSearch++;
    setCovers(null);
    searchTimer = setTimeout(
      () => void searchCovers({ artist: artist(), title: title(), duration: basis()?.duration ?? null }),
      SEARCH_DELAY,
    );
  };

  /** Looks the lyrics up for the current artist and title. */
  const searchLyrics = async () => {
    const search = ++lyricsSearchCount;
    lyricsFor = `${artist().trim()}\n${title().trim()}`;
    setLyricsSearch({ status: "searching" });
    let result: FoundLyrics | null;
    try {
      result = await native.youtube.findLyrics({
        artist: artist().trim(),
        title: title().trim(),
        duration: basis()?.duration ?? null,
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

  /** What Whisper hears in the draft's vocals, in the languages asked for. */
  const listen = async (heard: HeardLanguage) => {
    const downloaded = draft();
    if (!downloaded) return;
    listenController?.abort();
    const current = new AbortController();
    listenController = current;
    setListening({ status: "listening", progress: null });
    try {
      const iterator = await native.drafts.listen(
        { draftId: downloaded.draftId, ...heard },
        { signal: current.signal },
      );
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

  /** What main is told about the lyrics: LRCLIB's with their timing, heard ones, the user's own without, or none. */
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

  /** The language offered before the user picks one: the source's, else the one the last new project was sung in. */
  const suggestedLanguage = () => basis()?.language ?? settings()?.newProject.language ?? null;
  /** The language chosen for the song (ISO 639-1), or null for "don't know". */
  const chosenLanguage = () => {
    const picked = pickedLanguage();
    return picked === undefined ? suggestedLanguage() : picked;
  };

  /** The song's language: the chosen one, else what Whisper heard, else a guess from the lyrics. */
  const songLanguage = (): string | null => {
    const chosen = chosenLanguage();
    if (chosen) return chosen;
    const lyrics = projectLyrics();
    if (!lyrics) return null;
    if (lyrics.language && !lyrics.mixed) return lyrics.language;
    return guessLyricsLanguage(lyrics.lines.map((line) => line.text).join("\n"));
  };

  /** The chart is to be made: wanted, and it can be. */
  const wantsChart = () => makeChart() && chartUnavailable(songLanguage(), projectLyrics() !== null) === null;
  /** The made chart if it still fits the lyrics and language. */
  const currentChart = () => {
    const made = madeChart();
    return made && made.madeFrom === chartInputsKey(projectLyrics()?.lines, songLanguage()) ? made : null;
  };

  /** Where year and genre come from: the best match that is surely this song, whichever cover is chosen. */
  const songSource = () => covers()?.find((candidate) => candidate.confident) ?? null;

  /**
   * What main is told about the cover. A found cover counts only while the current search offers it: after artist or
   * title changed, the old pick waits for the new search, and saving before that answers uses the source's picture.
   */
  const coverChoice = (): CoverChoice => {
    const selection = cover();
    if (selection.kind === "found" && !covers()?.some((candidate) => candidate.url === selection.url)) {
      return { kind: "thumbnail" };
    }
    return selection.kind === "file" ? { kind: "file", path: selection.image.path } : selection;
  };

  return {
    basis,
    artist,
    title,
    settings,
    models,
    covers,
    cover,
    customCover,
    lyricsSearch,
    lyricsSource,
    ownLyrics,
    listening,
    makeChart,
    draft,
    chosenLanguage,
    songLanguage,
    wantsChart,
    currentChart,
    projectLyrics,
    songSource,
    coverChoice,
    listen,
    /** The source found the song: its details become the starting point, and covers are searched for them. */
    setBasis: (song: SongBasis) => {
      setBasis(song);
      setArtist(song.artist);
      setTitle(song.title);
      // Signals written just now still read their old value, so the search gets the details directly.
      void searchCovers(song);
    },
    setArtist: (value: string) => {
      setArtist(value);
      searchCoversSoon();
    },
    setTitle: (value: string) => {
      setTitle(value);
      searchCoversSoon();
    },
    setCover,
    setLanguage: setPickedLanguage,
    setMakeChart,
    chooseCoverFile: async () => {
      try {
        const image = await native.dialogs.chooseCoverImage();
        if (!image) return;
        setCustomCover(image);
        setCover({ kind: "file", image });
      } catch (error) {
        toast.add({ type: "error", title: "Couldn't use this image", description: errorMessage(error) });
      }
    },
    /** Looks the lyrics up again, but only when artist or title changed since the last time. */
    searchLyricsIfChanged: () => {
      if (lyricsFor !== `${artist().trim()}\n${title().trim()}`) void searchLyrics();
    },
    retryLyrics: () => void searchLyrics(),
    pickLyricsSource: (source: LyricsSource) => {
      lyricsSourcePicked = true;
      setLyricsSource(source);
    },
    /** Editing found or heard lyrics makes them the user's own; the originals stay as they were. */
    editLyrics: (text: string) => {
      lyricsSourcePicked = true;
      setOwnLyrics(text);
      setLyricsSource("own");
    },
    checkModels: async () => setModels(await native.models.status().catch(() => null)),
    /**
     * The song is in a draft now. A draft that arrives after the flow went away is thrown away, and so is one that
     * arrives when there is one already (a stopped download that finished anyway, after it was started again).
     */
    setDraft: (downloaded: DownloadedDraft) => {
      if (disposed || (currentDraft && currentDraft.draftId !== downloaded.draftId)) {
        native.drafts.discard({ draftId: downloaded.draftId }).catch(() => {});
        return;
      }
      currentDraft = downloaded;
      setDraft(downloaded);
    },
    setMadeChart,
    /** The project was saved: the draft is gone with it. */
    markSaved: () => {
      saved = true;
    },
  };
}

export type NewProject = ReturnType<typeof createNewProject>;
