const VIDEO_ID = /^[\w-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

/**
 * The video ID of a YouTube watch, share, shorts or embed link, or `null` if `text` isn't one.
 * Accepts links without a scheme, as people paste them from the address bar.
 */
export function parseYoutubeVideoId(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const url = URL.parse(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (!url) return null;

  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const [, kind, value] = url.pathname.split("/");
      if (kind === "shorts" || kind === "embed" || kind === "live") id = value ?? null;
    }
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/** What YouTube says about a video, as far as the song details go. */
export interface VideoFacts {
  title: string;
  channel: string;
  /** Set for music YouTube recognised, e.g. "Topic" channel uploads. */
  artist?: string | null;
  track?: string | null;
}

/** Words in brackets that describe the upload rather than the song. */
const UPLOAD_WORDS =
  /\b(official|video|audio|lyrics?|visuali[sz]er|music|clip|remaster(ed)?|hd|hq|4k|8k|1080p|720p|live|explicit|color coded|mv|m\/v)\b/i;

/** Removes "(Official Video)", "[4K Remaster]" and the like, and a trailing "| Channel" part. */
function cleanTitle(title: string): string {
  return title
    .replace(/\s*[|｜].*$/, "")
    .replace(/\s*[([【][^)\]】]*[)\]】]/g, (part) => (UPLOAD_WORDS.test(part) ? "" : part))
    .replace(/\s+(official\s+)?(music\s+)?(video|audio)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The channel as an artist name: without " - Topic", "VEVO" and "Official". */
function cleanChannel(channel: string): string {
  return channel
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s*(official)$/i, "")
    .trim();
}

/**
 * Artist and title for a song from its video: YouTube's own music details when it has them,
 * else "Artist - Title" from the video title, else the channel as the artist.
 */
export function suggestSongDetails(facts: VideoFacts): { artist: string; title: string } {
  if (facts.artist?.trim() && facts.track?.trim()) {
    return { artist: facts.artist.split(",")[0]!.trim(), title: facts.track.trim() };
  }
  const title = cleanTitle(facts.title);
  // A hyphen, en dash or em dash between artist and title.
  const split = /^(.+?)\s+[-\u2013\u2014]\s+(.+)$/.exec(title);
  if (split) return { artist: split[1]!.trim(), title: cleanTitle(split[2]!).replace(/^["“'](.*)["”']$/, "$1") };
  return { artist: cleanChannel(facts.channel), title: title || facts.title.trim() };
}
