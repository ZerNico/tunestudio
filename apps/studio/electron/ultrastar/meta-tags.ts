import { parseYoutubeVideoId } from "../../src/lib/youtube";

/** usdb_syncer's meta tags, as `[key, value]` pairs in order. */
export type MetaTags = [string, string][];

/** The meta tags in a `#VIDEO` value, or null when it is a file name (it has no `=`). */
export function parseMetaTags(value: string): MetaTags | null {
  if (!value.includes("=")) return null;
  return value
    .split(",")
    .filter((part) => part.includes("="))
    .map((part) => {
      const at = part.indexOf("=");
      return [
        part.slice(0, at).trim().toLowerCase(),
        part
          .slice(at + 1)
          .trim()
          .replaceAll("%2C", ","),
      ];
    });
}

/** Meta tags as a `#VIDEO` value: commas in values written as `%2C`. */
export function formatMetaTags(tags: MetaTags): string {
  return tags.map(([key, value]) => `${key}=${value.replaceAll(",", "%2C")}`).join(",");
}

/** One YouTube source from the meta tags, kept distinct from the other. */
export function youtubeIdOf(tags: MetaTags, key: "v" | "a"): string | null {
  const value = tags.find(([name]) => name === key)?.[1];
  return value ? parseYoutubeVideoId(value) : null;
}

/** Replaces imported source tags with the edited fields, including deliberately cleared ones. */
export function sourceMetaTags(
  tags: MetaTags,
  song: { youtubeId: string | null; youtubeAudioId: string | null },
): MetaTags {
  const sources: MetaTags = [];
  if (song.youtubeAudioId && song.youtubeAudioId !== song.youtubeId) sources.push(["a", song.youtubeAudioId]);
  if (song.youtubeId) sources.push(["v", song.youtubeId]);
  return [...sources, ...tags.filter(([key]) => key !== "a" && key !== "v")];
}
