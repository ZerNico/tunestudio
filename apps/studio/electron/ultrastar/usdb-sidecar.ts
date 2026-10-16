import { Schema } from "effect";

import { parseYoutubeVideoId } from "../../src/lib/youtube";
import { type MetaTags, parseMetaTags } from "./meta-tags";

// Syncer also writes status-only records for resources it couldn't download.
const Resource = Schema.NullOr(Schema.Struct({ resource: Schema.optional(Schema.NullOr(Schema.String)) }));
const Sidecar = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    txt: Schema.optional(Schema.NullOr(Schema.Struct({ fname: Schema.optional(Schema.String) }))),
    meta_tags: Schema.optional(Schema.NullOr(Schema.String)),
    audio: Schema.optional(Resource),
    video: Schema.optional(Resource),
  }),
);

/** Syncer's metadata for the selected chart; null if the sidecar belongs to a different chart. */
export function usdbSidecarTags(text: string, chart: string): MetaTags | null {
  const sidecar = Schema.decodeUnknownSync(Sidecar)(text);
  if (sidecar.txt?.fname !== chart) return null;
  // Resources are download history, possibly from comments. Never add them to declared metadata.
  if (sidecar.meta_tags != null) return parseMetaTags(sidecar.meta_tags) ?? [];
  const tags: MetaTags = [];
  for (const [key, record] of [
    ["v", sidecar.video],
    ["a", sidecar.audio],
  ] as const) {
    const id = record?.resource ? parseYoutubeVideoId(record.resource) : null;
    if (id) tags.push([key, id]);
  }
  return tags;
}
