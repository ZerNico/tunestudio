"""Line-synced lyrics from LRCLIB (https://lrclib.net), free and without an API key."""

import json
import re
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

API = "https://lrclib.net/api"
HEADERS = {"User-Agent": "tunestudio-training/0.1 (https://github.com/ZerNico/tunestudio)"}
LINE = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$")


@dataclass
class SyncedLine:
    start: float
    text: str


def parse_lrc(lrc: str) -> list[SyncedLine]:
    out = []
    for raw in lrc.splitlines():
        m = LINE.match(raw.strip())
        if m and m.group(3).strip():
            out.append(SyncedLine(int(m.group(1)) * 60 + float(m.group(2)), m.group(3).strip()))
    return out


def _fetch(artist: str, title: str, attempts: int = 5) -> list:
    """Search results; retries network errors and server errors (offline laptop, flaky Wi-Fi), so a failed
    lookup raises instead of being cached as "no lyrics"."""
    for i in range(attempts):
        try:
            r = httpx.get(
                f"{API}/search", params={"artist_name": artist, "track_name": title}, headers=HEADERS, timeout=30
            )
            if r.status_code < 500:
                return r.json() if r.status_code == 200 else []
        except httpx.HTTPError:
            if i == attempts - 1:
                raise
        time.sleep(min(60, 5 * 2**i))
    raise RuntimeError(f"LRCLIB unavailable for {artist} - {title}")


def search(
    artist: str, title: str, duration: float, cache: Path | None = None, tolerance: float = 4.0
) -> list[SyncedLine] | None:
    """Synced lyrics of the version whose duration is closest to `duration` (within `tolerance` seconds)."""
    found = versions(artist, title, duration, cache, tolerance)
    return found[0] if found else None


def versions(
    artist: str, title: str, duration: float, cache: Path | None = None, tolerance: float = 60.0
) -> list[list[SyncedLine]]:
    """Synced lyrics of every version within `tolerance` seconds of `duration`, closest duration first. The same
    lyrics are often uploaded for several edits (radio edit, music video with a long intro, remix), timed
    differently; pipeline._align_stage picks the timing that fits the recording."""
    if cache and cache.exists():
        results = json.loads(cache.read_text())
    else:
        results = _fetch(artist, title)
        if not isinstance(results, list):
            results = []
        if cache:
            cache.write_text(json.dumps(results))
    candidates = [
        x for x in results if x.get("syncedLyrics") and x.get("duration") and abs(x["duration"] - duration) <= tolerance
    ]
    return [parse_lrc(x["syncedLyrics"]) for x in sorted(candidates, key=lambda x: abs(x["duration"] - duration))]
