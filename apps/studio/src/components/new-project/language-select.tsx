import { For } from "solid-js";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { LANGUAGES, languageName } from "~/lib/languages";

/** The song's language isn't known. */
const UNKNOWN = "unknown";

/** The language a song is sung in: one of the common ones (or the one it is already), or "Don't know". */
export function LanguageSelect(props: {
  /** ISO 639-1 code, or null when unknown. */
  value: string | null;
  disabled?: boolean;
  onChange: (language: string | null) => void;
}) {
  const languages = () => (props.value && !LANGUAGES.includes(props.value) ? [props.value, ...LANGUAGES] : LANGUAGES);
  return (
    <Select
      value={props.value ?? UNKNOWN}
      disabled={props.disabled}
      onValueChange={(value: unknown) => props.onChange(value === UNKNOWN || typeof value !== "string" ? null : value)}
    >
      <SelectTrigger size="sm" aria-label="Language of the song" data-testid="song-language">
        <SelectValue>
          {(value: () => unknown) => <>{value() === UNKNOWN ? "Don't know" : languageName(String(value()))}</>}
        </SelectValue>
      </SelectTrigger>
      <SelectContent class="min-w-40">
        <SelectItem value={UNKNOWN}>Don't know</SelectItem>
        <For each={languages()}>{(code) => <SelectItem value={code}>{languageName(code)}</SelectItem>}</For>
      </SelectContent>
    </Select>
  );
}
