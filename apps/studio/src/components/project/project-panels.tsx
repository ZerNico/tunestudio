import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";
import FileAudioIcon from "~icons/lucide/file-audio";
import FileImageIcon from "~icons/lucide/file-image";
import FileVideoIcon from "~icons/lucide/file-video";
import TriangleAlertIcon from "~icons/lucide/triangle-alert";

import { Badge } from "~/components/ui/badge";
import { formatDuration, formatFileSize, formatNumber, formatSeconds } from "~/lib/format";
import type { LyricsLine, MediaRole, ProjectMedia, ProjectOverview } from "~/lib/native/types";

const ROLE_LABELS: Record<MediaRole, string> = {
  audio: "Audio",
  vocals: "Vocals",
  instrumental: "Instrumental",
  video: "Video",
  cover: "Cover",
  background: "Background",
};

/** A titled card on the project screen. */
export function Panel(props: { title: string; id: string; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <section
      aria-labelledby={`${props.id}-title`}
      class="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-[18px]"
      data-testid={`panel-${props.id}`}
    >
      <div class="flex items-center gap-2">
        <h2 id={`${props.id}-title`} class="m-0 text-[13px] font-semibold tracking-[-0.1px] text-foreground">
          {props.title}
        </h2>
        <div class="ml-auto flex items-center gap-2">{props.aside}</div>
      </div>
      {props.children}
    </section>
  );
}

/** Notes, lines, singers and length, as big numbers. */
export function ChartStats(props: { overview: ProjectOverview }) {
  const length = () => {
    const { chartStart, chartEnd } = props.overview;
    return chartStart === null || chartEnd === null ? "None" : formatDuration(chartEnd - chartStart);
  };
  const stats = () => [
    { label: "Notes", value: String(props.overview.notes), id: "notes" },
    { label: "Lines", value: String(props.overview.lines), id: "lines" },
    { label: "Singers", value: String(props.overview.singers.length), id: "singers" },
    { label: "Sung for", value: length(), id: "length" },
  ];
  return (
    <div class="flex flex-col gap-4">
      <dl class="m-0 grid grid-cols-4 gap-2">
        <For each={stats()}>
          {(stat) => (
            <div class="flex flex-col gap-1 rounded-lg border border-border-soft bg-gray-12 px-3 py-2.5">
              <dt class="eyebrow">{stat.label}</dt>
              <dd class="m-0 font-mono text-[18px] text-foreground tabular-nums" data-testid={`stat-${stat.id}`}>
                {stat.value}
              </dd>
            </div>
          )}
        </For>
      </dl>
      <ul class="m-0 flex list-none flex-col gap-1.5 p-0 text-[11.5px] text-muted-foreground">
        <For each={props.overview.singers}>
          {(singer) => (
            <li class="flex items-center gap-2">
              <Show when={props.overview.singers.length > 1}>
                <Badge variant="violet">P{singer.index}</Badge>
              </Show>
              <span class="truncate text-foreground">
                {singer.name ?? (props.overview.singers.length > 1 ? `Singer ${singer.index}` : "Solo")}
              </span>
              <span class="ml-auto font-mono text-[10.5px] tabular-nums">
                {singer.lines} lines · {singer.notes} notes
              </span>
            </li>
          )}
        </For>
        <Show when={props.overview.goldenNotes > 0}>
          <li class="flex items-center gap-2">
            <span>Golden notes</span>
            <span class="ml-auto font-mono text-[10.5px] tabular-nums">{props.overview.goldenNotes}</span>
          </li>
        </Show>
      </ul>
    </div>
  );
}

const time = (value: number | null) => (value === null ? null : formatSeconds(value));

/** The song's headers as label/value rows; empty values are left out. */
export function SongDetails(props: { overview: ProjectOverview }) {
  const rows = () => {
    const song = props.overview.song;
    return [
      ["BPM", formatNumber(song.bpm)],
      ["GAP", formatSeconds(song.gap)],
      ["Language", song.language.join(", ") || null],
      ["Year", song.year === null ? null : String(song.year)],
      ["Genre", song.genre],
      ["Edition", song.edition],
      ["Creator", song.creator],
      ["Preview from", time(song.previewStart)],
      ["Video gap", time(song.videoGap)],
      ["Starts at", time(song.start)],
      ["Ends at", time(song.end)],
      [
        "Medley",
        song.medleyStart === null || song.medleyEnd === null
          ? null
          : `${formatSeconds(song.medleyStart)} to ${formatSeconds(song.medleyEnd)}`,
      ],
    ].filter((row): row is [string, string] => row[1] !== null);
  };
  return (
    <div class="flex flex-col gap-3">
      <dl class="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-[11.5px]">
        <For each={rows()}>
          {([label, value]) => (
            <>
              <dt class="text-muted-foreground">{label}</dt>
              <dd class="m-0 truncate text-foreground" title={value}>
                {value}
              </dd>
            </>
          )}
        </For>
      </dl>
      <Show when={props.overview.song.extraHeaders.length > 0}>
        <div class="flex flex-col gap-1.5 border-t border-border-soft pt-3">
          <span class="eyebrow">Other headers, kept for export</span>
          <ul class="m-0 flex list-none flex-col gap-1 p-0 font-mono text-[10.5px]">
            <For each={props.overview.song.extraHeaders}>
              {([key, value]) => (
                <li class="flex min-w-0 gap-2">
                  <span class="shrink-0 text-sage-63">#{key}</span>
                  <span class="truncate text-muted-foreground" title={value}>
                    {value}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  );
}

/** Reads how long an audio or video file plays from its metadata, without loading it all. */
function createMediaDuration(item: () => ProjectMedia) {
  const [duration, setDuration] = createSignal<number | null>(item().duration);
  onSettled(() => {
    const media = item();
    if (media.duration !== null || !(media.mime.startsWith("audio/") || media.mime.startsWith("video/"))) return;
    const probe = document.createElement(media.mime.startsWith("video/") ? "video" : "audio");
    probe.preload = "metadata";
    probe.muted = true;
    const loaded = () => {
      if (Number.isFinite(probe.duration)) setDuration(probe.duration);
    };
    probe.addEventListener("loadedmetadata", loaded);
    probe.src = media.url;
    return () => {
      probe.removeEventListener("loadedmetadata", loaded);
      probe.removeAttribute("src");
      probe.load();
    };
  });
  return duration;
}

function MediaIcon(props: { mime: string }) {
  return (
    <Show
      when={props.mime.startsWith("image/")}
      fallback={props.mime.startsWith("video/") ? <FileVideoIcon /> : <FileAudioIcon />}
    >
      <FileImageIcon />
    </Show>
  );
}

function MediaRow(props: { media: ProjectMedia }) {
  const duration = createMediaDuration(() => props.media);
  return (
    <li
      class="grid grid-cols-[18px_96px_minmax(0,1fr)_80px_56px] items-center gap-3 px-3 py-2.5 text-[11.5px]"
      data-testid="media-row"
    >
      <span class="flex text-sage-63 [&>svg]:size-4">
        <MediaIcon mime={props.media.mime} />
      </span>
      <span class="text-muted-foreground">{ROLE_LABELS[props.media.role]}</span>
      <span class="truncate font-mono text-[10.5px] text-foreground" title={props.media.fileName}>
        {props.media.fileName}
      </span>
      <span class="text-right font-mono text-[10.5px] text-muted-foreground tabular-nums">
        {formatFileSize(props.media.size)}
      </span>
      <span class="text-right font-mono text-[10.5px] text-muted-foreground tabular-nums">
        {duration() === null ? "" : formatDuration(duration()!)}
      </span>
    </li>
  );
}

/** The project's media files: role, original name, size and length. */
export function MediaList(props: { media: ProjectMedia[] }) {
  return (
    <Show
      when={props.media.length > 0}
      fallback={<p class="m-0 text-[11.5px] text-muted-foreground">This project has no media.</p>}
    >
      <ul
        aria-label="Media"
        class="m-0 flex list-none flex-col divide-y divide-border-soft overflow-hidden rounded-lg border border-border-soft p-0"
      >
        <For each={props.media}>{(media) => <MediaRow media={media} />}</For>
      </ul>
    </Show>
  );
}

/** What importing the song reported, kept with the project. */
export function ImportNotes(props: { warnings: string[] }) {
  return (
    <ul
      class="m-0 flex list-none flex-col gap-2 p-0 text-[11.5px] leading-[1.6] text-amber-73"
      data-testid="import-notes"
    >
      <For each={props.warnings}>
        {(warning) => (
          <li class="flex gap-2">
            <TriangleAlertIcon class="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>{warning}</span>
          </li>
        )}
      </For>
    </ul>
  );
}

/** The song's lyrics, line by line, with each line's start when they are synced. */
export function LyricsList(props: { lines: LyricsLine[] }) {
  return (
    <ol
      aria-label="Lyrics"
      class="m-0 flex max-h-[320px] scrollbar-thin list-none flex-col gap-0.5 overflow-y-auto p-0 text-[12px] leading-[1.7]"
      data-testid="lyrics-lines"
    >
      <For each={props.lines}>
        {(line) => (
          <li class="flex gap-4">
            <Show when={line.start !== null}>
              <span class="w-10 shrink-0 text-right font-mono text-[10.5px] leading-[1.95] text-faint-foreground">
                {formatDuration(line.start ?? 0)}
              </span>
            </Show>
            <span class="text-foreground">{line.text}</span>
          </li>
        )}
      </For>
    </ol>
  );
}
