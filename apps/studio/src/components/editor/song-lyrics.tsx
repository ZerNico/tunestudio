/** The lyrics the song came with (as found or typed in setup), in the song details: to chart them by hand. */
import { For, Show } from "solid-js";

import { formatDuration } from "~/lib/format";
import type { LyricsLine } from "~/lib/native/types";

export function LyricsList(props: { lines: readonly LyricsLine[] }) {
  return (
    <ol
      aria-label="Lyrics"
      class="m-0 flex max-h-[320px] scrollbar-thin list-none flex-col gap-0.5 overflow-y-auto p-0 text-[12px] leading-[1.7] select-text"
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
