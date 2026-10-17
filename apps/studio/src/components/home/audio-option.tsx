import AudioLinesIcon from "~icons/lucide/audio-lines";
import FileAudioIcon from "~icons/lucide/file-audio";

import { Button } from "~/components/ui/button";

import { StartOption } from "./start-option";

/** Start from an audio file: a picker button, and a hint that the whole window takes drops. */
export function AudioOption(props: { onChoose: () => void }) {
  return (
    <StartOption
      id="audio"
      tone="lime"
      icon={<AudioLinesIcon />}
      title="Import an audio file"
      description="Chart a song file you already have."
    >
      <Button variant="secondary" size="lg" class="w-full" onClick={() => props.onChoose()} data-testid="audio-choose">
        <FileAudioIcon />
        Choose audio file
      </Button>
      <p class="m-0 min-h-[2lh] text-[11px] text-muted-foreground">
        Or drop it anywhere. MP3, M4A, FLAC, OGG, OPUS, WAV.
      </p>
    </StartOption>
  );
}
