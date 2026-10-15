import { createMemo, createSignal, Show } from "solid-js";
import ArrowRightIcon from "~icons/lucide/arrow-right";
import CircleCheckIcon from "~icons/lucide/circle-check";
import LinkIcon from "~icons/lucide/link";
import YoutubeIcon from "~icons/lucide/youtube";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { parseYoutubeVideoId } from "~/lib/youtube";

import { StartOption } from "./start-option";

/** Start from a YouTube link: a URL field that recognises a pasted link right away. */
export function YoutubeOption(props: { onStart: (url: string, videoId: string) => void }) {
  const [url, setUrl] = createSignal("");
  const [touched, setTouched] = createSignal(false);
  const videoId = createMemo(() => parseYoutubeVideoId(url()));
  const invalid = () => touched() && url().trim() !== "" && !videoId();

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    setTouched(true);
    const id = videoId();
    if (id) props.onStart(url().trim(), id);
  };

  return (
    <StartOption
      id="youtube"
      tone="youtube"
      icon={<YoutubeIcon />}
      title="Paste a YouTube link"
      description="Fetch the song, split off the vocals and chart it automatically."
    >
      <form class="flex gap-2" novalidate onSubmit={submit}>
        <InputGroup size="lg" class="flex-1">
          <InputGroupAddon>
            <Show when={videoId()} fallback={<LinkIcon />}>
              <CircleCheckIcon class="text-primary" />
            </Show>
          </InputGroupAddon>
          <InputGroupInput
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck={false}
            placeholder="youtube.com/watch?v=…"
            aria-label="YouTube link"
            aria-invalid={invalid() ? "true" : undefined}
            aria-describedby="youtube-status"
            value={url()}
            data-testid="youtube-url"
            onInput={(event) => setUrl(event.currentTarget.value)}
            onPaste={(event) => {
              const text = event.clipboardData?.getData("text") ?? "";
              if (parseYoutubeVideoId(text)) {
                // Replace whatever was typed: a pasted link is the whole value.
                event.preventDefault();
                event.currentTarget.value = text.trim();
                setUrl(text.trim());
                setTouched(true);
              }
            }}
            onBlur={() => setTouched(true)}
          />
        </InputGroup>
        <Button type="submit" size="lg" disabled={!videoId()} data-testid="youtube-start">
          Start
          <ArrowRightIcon />
        </Button>
      </form>
      {/* Two lines tall at any width, so an error message never moves the field. */}
      <p id="youtube-status" aria-live="polite" class="m-0 min-h-[2lh] text-[11px]">
        <Show
          when={invalid()}
          fallback={<span class="text-faint-foreground">Works with youtube.com, youtu.be and Shorts links.</span>}
        >
          <span class="text-destructive">That doesn't look like a YouTube video link.</span>
        </Show>
      </p>
    </StartOption>
  );
}
