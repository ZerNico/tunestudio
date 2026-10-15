import type { JSX } from "@solidjs/web";
import { getRouteApi, useNavigate } from "@tanstack/solid-router";
import { createSignal, For, onSettled, Show } from "solid-js";
import LoaderCircleIcon from "~icons/lucide/loader-circle";

import { NavRail, type RailItem } from "~/components/home/nav-rail";
import { describeToolProgress } from "~/components/home/tools-step";
import { TitleBar } from "~/components/title-bar";
import { Button } from "~/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { toast } from "~/components/ui/toast";
import { formatFileSize, formatRelativeTime } from "~/lib/format";
import { MODEL_FEATURE_INFO, type ModelFeature } from "~/lib/models";
import { native } from "~/lib/native/client";
import { errorMessage, isAbort } from "~/lib/native/errors";
import type { ImportProgress, ModelFeatureStatus, ToolName, ToolProgress, ToolStatus } from "~/lib/native/types";
import {
  AUDIO_BITRATES,
  AUDIO_FORMAT_LABELS,
  AUDIO_FORMATS,
  AUDIO_NORMALIZATION_LABELS,
  AUDIO_NORMALIZATIONS,
  type Settings,
  VIDEO_FORMAT_LABELS,
  VIDEO_FORMATS,
  VIDEO_FPS,
  VIDEO_RESOLUTIONS,
} from "~/lib/settings";

const route = getRouteApi("/settings");

const TOOLS: { tool: ToolName; label: string; purpose: string }[] = [
  { tool: "yt-dlp", label: "yt-dlp", purpose: "Downloads from YouTube" },
  { tool: "quickjs", label: "QuickJS", purpose: "Answers YouTube's checks for yt-dlp" },
  { tool: "ffmpeg", label: "FFmpeg", purpose: "Converts audio and video" },
];

const NORMALIZATION_HINTS: Record<Settings["audio"]["normalization"], string> = {
  off: "The audio keeps the volume it was uploaded with.",
  replaygain: "Adds volume tags for players that support ReplayGain. The audio itself stays as downloaded.",
  rewrite: "Converts the audio to an even loudness, so every song plays about as loud.",
};

type Option<V> = { value: V; label: string };

const options = <V extends string | number>(values: readonly V[], label: (value: V) => string): Option<V>[] =>
  values.map((value) => ({ value, label: label(value) }));

/** The app settings: how YouTube downloads are saved, the download tools and the models. */
export default function SettingsScreen() {
  const loaded = route.useLoaderData();
  const navigate = useNavigate();
  const [settings, setSettings] = createSignal<Settings>(loaded().settings);

  const selectRail = (item: RailItem) => {
    if (item === "home") void navigate({ to: "/" });
    if (item === "recent") void navigate({ to: "/", hash: "recent" });
  };

  /** Applies a change right away and saves it; if saving fails, shows what is stored instead. */
  const save = (next: Settings) => {
    setSettings(next);
    native.settings.set(next).catch(async (error: unknown) => {
      toast.add({ type: "error", title: "Couldn't save the settings", description: errorMessage(error) });
      setSettings(await native.settings.get());
    });
  };
  const setAudio = (change: Partial<Settings["audio"]>) =>
    save({ ...settings(), audio: { ...settings().audio, ...change } });
  const setVideo = (change: Partial<Settings["video"]>) =>
    save({ ...settings(), video: { ...settings().video, ...change } });

  const bitrateHint = () => {
    const { format, normalization } = settings().audio;
    if (format === "mp3" || format === "ogg" || normalization === "rewrite") {
      return "The quality the audio is converted at.";
    }
    return `${AUDIO_FORMAT_LABELS[format]} is saved as YouTube serves it; this applies only when it is normalized.`;
  };

  return (
    <div class="flex h-dvh min-h-0 flex-col bg-background" data-testid="settings">
      <TitleBar />
      <div class="flex min-h-0 flex-1">
        <NavRail active="settings" onSelect={selectRail} />
        <main class="min-h-0 flex-1 scrollbar-thin overflow-y-auto" aria-labelledby="settings-title">
          <div class="mx-auto flex max-w-[760px] flex-col gap-9 px-10 pt-9 pb-16">
            <header class="flex flex-col gap-2">
              <h1
                id="settings-title"
                class="m-0 text-[27px] leading-tight font-[550] tracking-[-0.8px] text-foreground"
              >
                Settings
              </h1>
              <p class="m-0 text-[13px] leading-[1.6] text-muted-foreground">Changes are saved right away.</p>
            </header>

            <Section
              id="downloads"
              title="YouTube downloads"
              description="How audio and video from YouTube are saved in new projects. Media already in a project stays as it is."
            >
              <Group title="Audio">
                <ChoiceRow
                  id="audio-format"
                  label="Format"
                  description="M4A and Opus are what YouTube serves, so they are saved without converting. MP3 and OGG are converted, which loses a little quality."
                  value={settings().audio.format}
                  options={options(AUDIO_FORMATS, (format) => AUDIO_FORMAT_LABELS[format])}
                  onChange={(format) => setAudio({ format })}
                />
                <ChoiceRow
                  id="audio-bitrate"
                  label="Bitrate"
                  description={bitrateHint()}
                  value={settings().audio.bitrate}
                  options={options(AUDIO_BITRATES, (bitrate) => `${bitrate} kbps`)}
                  onChange={(bitrate) => setAudio({ bitrate })}
                />
                <ChoiceRow
                  id="audio-normalization"
                  label="Volume normalization"
                  description={NORMALIZATION_HINTS[settings().audio.normalization]}
                  value={settings().audio.normalization}
                  options={options(AUDIO_NORMALIZATIONS, (mode) => AUDIO_NORMALIZATION_LABELS[mode])}
                  onChange={(normalization) => setAudio({ normalization })}
                />
              </Group>

              <Group title="Video">
                <Row
                  id="video-download"
                  label="Download video"
                  description="Off saves only the audio. The video can still be added to a project later."
                >
                  <Switch
                    aria-labelledby="video-download"
                    checked={settings().video.download}
                    onCheckedChange={(download: boolean) => setVideo({ download })}
                    data-testid="video-download"
                  />
                </Row>
                <ChoiceRow
                  id="video-format"
                  label="Format"
                  description="H.264 plays in every karaoke app. AV1 and VP9 are smaller, but older apps can't play them."
                  disabled={!settings().video.download}
                  value={settings().video.format}
                  options={options(VIDEO_FORMATS, (format) => VIDEO_FORMAT_LABELS[format])}
                  onChange={(format) => setVideo({ format })}
                />
                <ChoiceRow
                  id="video-resolution"
                  label="Maximum resolution"
                  description="Videos are downloaded at this size or the largest one below it."
                  disabled={!settings().video.download}
                  value={settings().video.maxResolution}
                  options={options(VIDEO_RESOLUTIONS, (height) => `${height}p`)}
                  onChange={(maxResolution) => setVideo({ maxResolution })}
                />
                <ChoiceRow
                  id="video-fps"
                  label="Maximum frame rate"
                  disabled={!settings().video.download}
                  value={settings().video.maxFps}
                  options={options(VIDEO_FPS, (fps) => `${fps} fps`)}
                  onChange={(maxFps) => setVideo({ maxFps })}
                />
              </Group>
            </Section>

            <ToolsSection initial={loaded().tools} />

            <ModelsSection initial={loaded().models} />
          </div>
        </main>
      </div>
    </div>
  );
}

function Section(props: { id: string; title: string; description: string; children: JSX.Element }) {
  return (
    <section aria-labelledby={`${props.id}-title`} class="flex flex-col gap-4" data-testid={`settings-${props.id}`}>
      <div class="flex flex-col gap-1">
        <h2 id={`${props.id}-title`} class="m-0 text-[15px] font-semibold tracking-[-0.2px]">
          {props.title}
        </h2>
        <p class="m-0 text-[12px] leading-[1.6] text-muted-foreground">{props.description}</p>
      </div>
      {props.children}
    </section>
  );
}

function Group(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2">
      <h3 class="m-0 eyebrow">{props.title}</h3>
      <div class="flex flex-col divide-y divide-border rounded-[10px] border border-border bg-card">
        {props.children}
      </div>
    </div>
  );
}

/** A setting: its name and what it does on the left, the control on the right. */
function Row(props: { id: string; label: string; description?: string; children: JSX.Element }) {
  return (
    <div class="flex items-center gap-6 px-4 py-3">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={props.id} class="text-[12.5px] font-medium text-foreground">
          {props.label}
        </span>
        <Show when={props.description}>
          <p class="m-0 text-[11px] leading-normal text-muted-foreground">{props.description}</p>
        </Show>
      </div>
      {props.children}
    </div>
  );
}

function ChoiceRow<V extends string | number>(props: {
  id: string;
  label: string;
  description?: string;
  value: V;
  options: Option<V>[];
  disabled?: boolean;
  onChange: (value: V) => void;
}) {
  return (
    <Row id={props.id} label={props.label} description={props.description}>
      <Select
        items={props.options}
        value={props.value}
        disabled={props.disabled}
        onValueChange={(value: V | null) => {
          if (value !== null) props.onChange(value);
        }}
      >
        <SelectTrigger class="w-44 shrink-0" aria-labelledby={props.id} data-testid={props.id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <For each={props.options}>{(option) => <SelectItem value={option.value}>{option.label}</SelectItem>}</For>
        </SelectContent>
      </Select>
    </Row>
  );
}

/** What is installed of the download tools, with a way to check for updates now. */
function ToolsSection(props: { initial: readonly ToolStatus[] }) {
  const [status, setStatus] = createSignal<readonly ToolStatus[]>(props.initial);
  const [progress, setProgress] = createSignal<ToolProgress | null>(null);
  const [checking, setChecking] = createSignal(false);
  let controller: AbortController | undefined;

  onSettled(() => () => controller?.abort());

  const installed = () => status().every((tool) => tool.version !== null);
  const [removing, setRemoving] = createSignal<ToolName | null>(null);

  const remove = async (tool: ToolName) => {
    setRemoving(tool);
    try {
      setStatus(await native.tools.remove({ tool }));
    } catch (error) {
      toast.add({ type: "error", title: "Couldn't remove the tool", description: errorMessage(error) });
    } finally {
      setRemoving(null);
    }
  };
  const statusOf = (tool: ToolName) => status().find((entry) => entry.tool === tool);

  const check = async () => {
    controller = new AbortController();
    setChecking(true);
    setProgress(null);
    try {
      const iterator = await native.tools.prepare(
        { tools: TOOLS.map((entry) => entry.tool), force: true },
        { signal: controller.signal },
      );
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          setStatus(next.value);
          break;
        }
        setProgress(next.value);
      }
    } catch (error) {
      if (isAbort(error)) return;
      toast.add({ type: "error", title: "Couldn't update the download tools", description: errorMessage(error) });
      setStatus(await native.tools.status());
    } finally {
      setChecking(false);
      setProgress(null);
    }
  };

  return (
    <Section
      id="tools"
      title="Download tools"
      description="Tune Studio keeps these up to date by itself: yt-dlp is checked daily, the others monthly. Removing one frees the space; it is installed again when needed."
    >
      <div class="flex flex-col divide-y divide-border rounded-[10px] border border-border bg-card">
        <For each={TOOLS}>
          {(entry) => (
            <div class="flex items-center gap-6 px-4 py-3" data-testid={`tool-${entry.tool}`}>
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-[12.5px] font-medium text-foreground">{entry.label}</span>
                <p class="m-0 text-[11px] leading-normal text-muted-foreground">{entry.purpose}</p>
              </div>
              <div class="flex flex-col items-end gap-0.5 text-right">
                <Show
                  when={statusOf(entry.tool)?.version}
                  fallback={<span class="text-[11.5px] text-muted-foreground">Not installed</span>}
                >
                  {(version) => <span class="font-mono text-[11px] text-foreground">{version()}</span>}
                </Show>
                <Show when={statusOf(entry.tool)?.checkedAt}>
                  {(checkedAt) => (
                    <span class="text-[10.5px] text-muted-foreground">
                      Last check: {formatRelativeTime(new Date(checkedAt()).toISOString())}
                    </span>
                  )}
                </Show>
              </div>
              <Show when={statusOf(entry.tool)?.version}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={checking() || removing() !== null}
                  onClick={() => void remove(entry.tool)}
                  data-testid={`tool-${entry.tool}-remove`}
                >
                  Remove
                </Button>
              </Show>
            </div>
          )}
        </For>
      </div>
      <div class="flex min-h-7 items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={checking() || removing() !== null}
          onClick={() => void check()}
          data-testid="tools-check"
        >
          {installed() ? "Check for updates" : "Download tools"}
        </Button>
        <Show when={checking()}>
          <p class="m-0 flex items-center gap-2 text-[11.5px] text-muted-foreground" aria-live="polite">
            <LoaderCircleIcon class="size-4 animate-spin text-primary" />
            {describeToolProgress(progress())}
          </p>
        </Show>
      </div>
    </Section>
  );
}

/** How much of a feature's models is there, in two lines like a tool's version and last check. */
export function describeModels(status: ModelFeatureStatus): { state: string; detail: string } {
  if (status.downloaded >= status.size) {
    return {
      state: formatFileSize(status.size),
      detail: status.downloadedAt
        ? `Downloaded: ${formatRelativeTime(new Date(status.downloadedAt).toISOString())}`
        : "Downloaded",
    };
  }
  if (status.downloaded === 0) return { state: "Not downloaded", detail: `${formatFileSize(status.size)} to download` };
  return {
    state: "Partly downloaded",
    detail: `${formatFileSize(status.downloaded)} of ${formatFileSize(status.size)}`,
  };
}

/**
 * The models, by what they are for: whether they are downloaded, where they come from and under which license, with
 * a way to download them ahead of time or remove them to free the space.
 */
function ModelsSection(props: { initial: readonly ModelFeatureStatus[] }) {
  const [status, setStatus] = createSignal<readonly ModelFeatureStatus[]>(props.initial);
  /** The feature being downloaded or removed, and how far a download is. */
  const [busy, setBusy] = createSignal<{ feature: ModelFeature; progress: ImportProgress | null } | null>(null);
  let controller: AbortController | undefined;

  onSettled(() => () => controller?.abort());

  const download = async (feature: ModelFeature) => {
    controller = new AbortController();
    setBusy({ feature, progress: null });
    try {
      const iterator = await native.models.download({ feature }, { signal: controller.signal });
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          setStatus(next.value);
          break;
        }
        setBusy({ feature, progress: next.value });
      }
    } catch (error) {
      if (isAbort(error)) return;
      toast.add({ type: "error", title: "Couldn't download the models", description: errorMessage(error) });
      setStatus(await native.models.list().catch(() => status()));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (feature: ModelFeature) => {
    setBusy({ feature, progress: null });
    try {
      setStatus(await native.models.remove({ feature }));
    } catch (error) {
      toast.add({ type: "error", title: "Couldn't remove the models", description: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      id="models"
      title="Models"
      description="Downloaded the first time a feature needs them, from Hugging Face and GitHub. Each version of Tune Studio uses fixed versions of them; an update brings newer ones, downloaded when next needed. Removing them frees the space."
    >
      <div class="flex flex-col divide-y divide-border rounded-[10px] border border-border bg-card">
        <For each={status()}>
          {(entry) => {
            const info = MODEL_FEATURE_INFO[entry.feature];
            const working = () => busy()?.feature === entry.feature;
            const progress = () => (working() ? busy()?.progress : null);
            return (
              <div class="flex flex-col gap-3 px-4 py-3.5" data-testid={`models-${entry.feature}`}>
                <div class="flex items-center gap-6">
                  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="text-[12.5px] font-medium text-foreground">{info.label}</span>
                    <p class="m-0 text-[11px] leading-normal text-muted-foreground">{info.purpose}</p>
                  </div>
                  <div
                    class="flex shrink-0 flex-col items-end gap-0.5 text-right"
                    data-testid={`models-${entry.feature}-status`}
                  >
                    <span
                      data-ready={entry.downloaded >= entry.size ? "" : undefined}
                      class="text-[11.5px] text-muted-foreground data-ready:font-mono data-ready:text-[11px] data-ready:text-foreground"
                    >
                      {describeModels(entry).state}
                    </span>
                    <span class="text-[10.5px] text-muted-foreground">{describeModels(entry).detail}</span>
                  </div>
                  <div class="flex shrink-0 gap-1.5">
                    <Show when={entry.downloaded < entry.size}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy() !== null}
                        onClick={() => void download(entry.feature)}
                        data-testid={`models-${entry.feature}-download`}
                      >
                        <Show when={working()}>
                          <LoaderCircleIcon class="animate-spin" />
                        </Show>
                        Download
                      </Button>
                    </Show>
                    <Show when={entry.downloaded > 0}>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy() !== null}
                        onClick={() => void remove(entry.feature)}
                        data-testid={`models-${entry.feature}-remove`}
                      >
                        Remove
                      </Button>
                    </Show>
                  </div>
                </div>
                <ul
                  aria-label={`${info.label} models`}
                  class="m-0 flex list-none flex-col gap-1 rounded-lg bg-muted/40 px-3 py-2"
                >
                  <For each={entry.models}>
                    {(model) => (
                      <li class="flex items-baseline gap-4 text-[10.5px] text-muted-foreground">
                        <span class="min-w-0 flex-1 truncate">{model.credit}</span>
                        <span class="w-16 shrink-0 font-mono text-[10px]" title="Version">
                          {model.version}
                        </span>
                        <span class="w-28 shrink-0 text-right font-mono text-[10px]">{model.license}</span>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={progress()}>
                  {(current) => (
                    <div class="flex items-center gap-3" aria-live="polite">
                      <progress
                        aria-label={`${info.label} download`}
                        max={current().total}
                        value={current().done}
                        class="h-1.5 flex-1 appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-sage-22 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
                      />
                      <span class="font-mono text-[10.5px] text-muted-foreground tabular-nums">
                        {formatFileSize(current().done)} of {formatFileSize(current().total)}
                      </span>
                    </div>
                  )}
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </Section>
  );
}
