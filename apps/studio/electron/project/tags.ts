/**
 * The song's tags. UltraStar keeps them in `#TAGS` as a comma-separated list; the project keeps that header among the
 * song's other headers (in file order), so the tags are read from and written to it there.
 */
const TAGS = "TAGS";

/** The tags in the headers (none: no `#TAGS`, or an empty one). */
export function tagsOf(headers: readonly (readonly [string, string])[]): string[] {
  const value = headers.find(([name]) => name.toUpperCase() === TAGS)?.[1] ?? "";
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** The headers with these tags: `#TAGS` changed where it is, added at the end, or dropped when there are none. */
export function withTags(headers: readonly (readonly [string, string])[], tags: readonly string[]): [string, string][] {
  const value = tags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .join(", ");
  const at = headers.findIndex(([name]) => name.toUpperCase() === TAGS);
  const kept = headers.map(([name, text]) => [name, text] as [string, string]);
  if (at < 0) return value ? [...kept, [TAGS, value]] : kept;
  if (!value) return kept.filter((_, i) => i !== at);
  kept[at] = [kept[at]![0], value];
  return kept;
}

/** The headers besides `#TAGS` (which is edited as the tags). */
export function withoutTags(headers: readonly (readonly [string, string])[]): [string, string][] {
  return headers.filter(([name]) => name.toUpperCase() !== TAGS).map(([name, text]) => [name, text]);
}
