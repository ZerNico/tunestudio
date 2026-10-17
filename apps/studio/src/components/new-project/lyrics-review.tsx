import { For, Match, Show, Switch } from "solid-js";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { Button } from "~/components/ui/button";
import { Note } from "~/components/ui/note";
import { ProgressBar } from "~/components/ui/progress-bar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { formatFileSize } from "~/lib/format";
import { LANGUAGES, languageName } from "~/lib/languages";
import { guessLyricsLanguage } from "~/lib/lyrics-language";
import { percentOf } from "~/lib/native/progress";
import type { FoundLyrics, HeardLyrics, Progress } from "~/lib/native/types";
import { GETTING_LISTENING_MODEL } from "~/lib/steps";

/** The lyrics search: still running, done with what was found, or the lyrics service couldn't be reached. */
export type LyricsSearch =
  | { status: "searching" }
  | { status: "done"; found: FoundLyrics | null }
  | { status: "failed"; message: string };

/** Whisper listening to the song: not asked yet, at work, done, or failed. */
export type Listening =
  | { status: "idle" }
  | { status: "listening"; progress: Progress | null }
  | { status: "done"; heard: HeardLyrics }
  /** `request` is what was asked for, so trying again asks for the same. */
  | { status: "failed"; message: string; request: HeardLanguage };

/** Where a new project's lyrics come from: found online, heard by Whisper, or the user's own text. */
export type LyricsSource = "found" | "heard" | "own";

/** Lyrics timed to a recording this much longer or shorter than the video are likely another version. */
const OTHER_VERSION_SECONDS = 20;

/** The language choice for a song sung in several. */
const MIXED = "mixed";

/** Which languages to listen for: one (null: the one most of the song is in), or each stretch its own. */
export interface HeardLanguage {
  language: string | null;
  mixed: boolean;
}

const lineCount = (count: number) => `${count} ${count === 1 ? "line" : "lines"}`;

/** The found lyrics' lines, as text. */
export function foundText(search: LyricsSearch): string {
  return search.status === "done" && search.found ? search.found.lines.map((line) => line.text).join("\n") : "";
}

/** Whether the found lyrics can be chosen. */
export function hasFound(search: LyricsSearch): boolean {
  return search.status === "done" && search.found !== null && search.found.lines.length > 0;
}

/** What Whisper heard, as text. */
export function heardText(listening: Listening): string {
  return listening.status === "done" ? listening.heard.lines.map((line) => line.text).join("\n") : "";
}

/**
 * Why the shown lyrics may not fit the song's language: Whisper heard another one (listening again in the song's
 * language helps), or they look like another one. Null when they fit, or either isn't known.
 */
export function languageMismatch(
  language: string | null,
  source: LyricsSource,
  listening: Listening,
  text: string,
): { text: string; listenAgain: boolean } | null {
  if (!language) return null;
  const sung = languageName(language);
  if (source === "heard") {
    const heard = listening.status === "done" ? listening.heard : null;
    if (!heard || heard.mixed || heard.lines.length === 0 || heard.language === language) return null;
    return {
      text: `These were heard in ${languageName(heard.language)}, but the song is sung in ${sung}, so the words are likely wrong.`,
      listenAgain: true,
    };
  }
  const looks = guessLyricsLanguage(text);
  if (!looks || looks === language) return null;
  return {
    text: `These lyrics look ${languageName(looks)}, but the song is sung in ${sung}. Check that they belong to it, or change the language.`,
    listenAgain: false,
  };
}

/** How far listening is, in a few words. */
function describeListening(progress: Progress | null): string {
  if (progress?.step === GETTING_LISTENING_MODEL) {
    return `Getting the listening model (first time only)… ${formatFileSize(progress.done)} of ${formatFileSize(progress.total)}`;
  }
  return `Listening to the song… ${percentOf(progress) ?? 0}%`;
}

/** The line under the source switch: what the chosen lyrics are, in plain words. */
export function describeSource(
  source: LyricsSource,
  search: LyricsSearch,
  listening: Listening,
  ownLines: number,
  video: number | null,
): { text: string; tone: "plain" | "busy" | "warning" } {
  if (source === "own") {
    return ownLines > 0
      ? { text: `${lineCount(ownLines)}, written by you`, tone: "plain" }
      : { text: "Paste or write the lyrics, one line of the song per row.", tone: "plain" };
  }
  if (source === "heard") {
    if (listening.status === "idle") return { text: "Not listened to yet.", tone: "plain" };
    if (listening.status === "listening") return { text: describeListening(listening.progress), tone: "busy" };
    if (listening.status === "failed") return { text: listening.message, tone: "warning" };
    const heard = listening.heard;
    if (heard.lines.length === 0) return { text: "Nothing sung was heard.", tone: "plain" };
    const languages = heard.mixed
      ? `several languages, mostly ${languageName(heard.language)}`
      : languageName(heard.language);
    return {
      text: `${lineCount(heard.lines.length)} heard in ${languages}. Words can be misheard, so check them.`,
      tone: "plain",
    };
  }
  if (search.status === "searching") return { text: "Looking for lyrics online…", tone: "busy" };
  if (search.status === "failed") return { text: "Couldn't look for lyrics online right now.", tone: "warning" };
  const found = search.found;
  if (!found) return { text: "No lyrics found online.", tone: "plain" };
  if (found.instrumental && found.lines.length === 0) {
    return { text: "Listed online as an instrumental, without lyrics.", tone: "plain" };
  }
  if (found.versionMismatch) {
    return {
      text: `${lineCount(found.lines.length)} from LRCLIB for another version. Check the words and timing.`,
      tone: "warning",
    };
  }
  const length = found.duration !== null && video !== null ? Math.abs(found.duration - video) : null;
  if (length !== null && length > OTHER_VERSION_SECONDS) {
    return {
      text: `${lineCount(found.lines.length)} from LRCLIB, maybe for another version of the song. Check them.`,
      tone: "warning",
    };
  }
  return {
    text: `${lineCount(found.lines.length)} from LRCLIB${length === null ? "" : ", matching the song's length"}`,
    tone: "plain",
  };
}

/**
 * The lyrics a new project starts with: where they come from (found online, heard in the song
 * by Whisper, or the user's own), a line saying what they are, and the text. Editing found or
 * heard lyrics copies them into the user's own, so the originals stay one click away.
 */
export function LyricsReview(props: {
  search: LyricsSearch;
  listening: Listening;
  /** The listening model isn't downloaded yet: listening starts with that. */
  listeningModelMissing?: boolean;
  source: LyricsSource;
  /** The user's own lyrics. */
  ownText: string;
  videoDuration: number | null;
  /** The language the song is sung in (ISO 639-1), which listening listens for; null when unknown. */
  language: string | null;
  disabled?: boolean;
  onSource: (source: LyricsSource) => void;
  onOwnText: (text: string) => void;
  /** Searches again after the lyrics service couldn't be reached. */
  onRetry: () => void;
  /** Listens (again) for these languages. */
  onListen: (heard: HeardLanguage) => void;
}) {
  const ownLines = () => props.ownText.split("\n").filter((line) => line.trim()).length;
  const describe = () => describeSource(props.source, props.search, props.listening, ownLines(), props.videoDuration);
  const heard = () => (props.listening.status === "done" ? props.listening.heard : null);
  const shownText = () => {
    if (props.source === "own") return props.ownText;
    return props.source === "heard" ? heardText(props.listening) : foundText(props.search);
  };
  const showsText = () =>
    props.source === "own" ||
    (props.source === "found" && hasFound(props.search)) ||
    (props.source === "heard" && (heard()?.lines.length ?? 0) > 0);
  const songLanguage = (): HeardLanguage => ({ language: props.language, mixed: false });
  const mismatch = () => languageMismatch(props.language, props.source, props.listening, shownText());
  const languages = () => {
    const current = heard()?.language;
    return current && !LANGUAGES.includes(current) ? [current, ...LANGUAGES] : LANGUAGES;
  };
  const listeningProgress = () => {
    if (props.listening.status !== "listening") return undefined;
    return percentOf(props.listening.progress);
  };
  return (
    <div class="flex flex-col gap-2" data-testid="lyrics-review">
      <ToggleGroup
        variant="segment"
        size="segment"
        spacing={0.5}
        aria-label="Lyrics from"
        value={[props.source]}
        disabled={props.disabled}
        onValueChange={(value: unknown[]) => {
          const next = value[0];
          if (next === "found" || next === "heard" || next === "own") props.onSource(next);
        }}
      >
        <ToggleGroupItem value="found" disabled={props.search.status === "done" && !hasFound(props.search)}>
          Found online
        </ToggleGroupItem>
        <ToggleGroupItem value="heard">Heard in the song</ToggleGroupItem>
        <ToggleGroupItem value="own">Your own</ToggleGroupItem>
      </ToggleGroup>
      <div class="flex min-h-[26px] items-center gap-3">
        <p
          data-tone={describe().tone}
          class="m-0 flex min-w-0 flex-1 items-center gap-2 text-[11px] text-popover-muted data-[tone=warning]:text-amber-73"
          aria-live="polite"
          data-testid="lyrics-summary"
        >
          <Show when={describe().tone === "busy"}>
            <LoaderCircleIcon class="size-3.5 shrink-0 animate-spin text-primary" />
          </Show>
          {describe().text}
          <Show
            when={
              (props.source === "found" && props.search.status === "failed") ||
              (props.source === "heard" && props.listening.status === "failed")
            }
          >
            <Button
              variant="outline"
              size="xs"
              class="ml-1"
              disabled={props.disabled}
              onClick={() => {
                const listening = props.listening;
                if (props.source !== "heard") props.onRetry();
                else props.onListen(listening.status === "failed" ? listening.request : songLanguage());
              }}
              data-testid="lyrics-retry"
            >
              Try again
            </Button>
          </Show>
        </p>
        <Show when={props.source === "heard" && heard()}>
          {(current) => (
            <Select
              value={current().mixed ? MIXED : current().language}
              disabled={props.disabled}
              onValueChange={(value: unknown) => {
                if (value === MIXED && !current().mixed) props.onListen({ language: null, mixed: true });
                else if (
                  typeof value === "string" &&
                  value !== MIXED &&
                  (current().mixed || value !== current().language)
                ) {
                  props.onListen({ language: value, mixed: false });
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Language of the song">
                <SelectValue>
                  {(value: () => unknown) => (
                    <>{value() === MIXED ? "Several languages" : languageName(String(value()))}</>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent class="min-w-40">
                <SelectItem value={MIXED}>Several languages</SelectItem>
                <For each={languages()}>{(code) => <SelectItem value={code}>{languageName(code)}</SelectItem>}</For>
              </SelectContent>
            </Select>
          )}
        </Show>
      </div>
      <Show when={showsText() && mismatch()}>
        {(found) => (
          <Note tone="warning" testid="lyrics-language-warning">
            <span class="flex items-center gap-3">
              <span class="flex-1">{found().text}</span>
              <Show when={found().listenAgain}>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={props.disabled}
                  onClick={() => props.onListen(songLanguage())}
                  data-testid="lyrics-listen-again"
                >
                  Listen again in {languageName(props.language ?? "")}
                </Button>
              </Show>
            </span>
          </Note>
        )}
      </Show>
      <Switch>
        <Match when={showsText()}>
          <Textarea
            aria-label="Lyrics"
            class="[field-sizing:fixed] h-[260px] scrollbar-thin overflow-y-auto"
            value={shownText()}
            disabled={props.disabled}
            placeholder="One line of the song per row"
            onInput={(event) => props.onOwnText(event.currentTarget.value)}
            data-testid="lyrics-text"
          />
        </Match>
        <Match when={true}>
          <div class="flex h-[260px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-popover-line px-10 text-center text-[11px] text-popover-muted">
            <Switch fallback="Choose “Your own” to paste or write the lyrics.">
              <Match when={props.source === "heard" && props.listening.status === "idle"}>
                <span>
                  Tune Studio can listen to the song and write down what is sung.
                  {props.listeningModelMissing ? " The first time, it downloads what it needs for that (547 MB)." : ""}
                </span>
                <Button
                  disabled={props.disabled}
                  onClick={() => props.onListen(songLanguage())}
                  data-testid="lyrics-listen"
                >
                  Listen to the song
                </Button>
              </Match>
              <Match when={props.source === "heard" && props.listening.status !== "done"}>
                <Show
                  when={props.listening.status !== "failed"}
                  fallback="Choose “Your own” to paste or write the lyrics."
                >
                  <LoaderCircleIcon class="size-4 animate-spin text-primary" />
                  <ProgressBar label="Listening progress" value={listeningProgress()} class="w-48" />
                  Writing down what is sung in the song. This takes a moment.
                </Show>
              </Match>
              <Match when={props.source === "found" && props.search.status === "searching"}>
                <LoaderCircleIcon class="size-4 animate-spin text-primary" />
              </Match>
            </Switch>
          </div>
        </Match>
      </Switch>
    </div>
  );
}
