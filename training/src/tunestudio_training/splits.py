"""The frozen splits (`training/splits/`): song folder names per split, grouped by primary artist so no voice is in two
of train, dev and test, and manifest.json with every song's artist, language, chart sha1 and split.

- train: training data. The first 669 songs have no "added" stamp in the manifest: the aligner and the boundary head
  were trained on those (`original`); the note refiners on all of them.
- dev: songs used for every model decision. Other songs by these artists are in train, so dev is slightly optimistic.
- test: locked, artists in no other split. Only for the final report of a model already decided on.
- sel: 60 train songs held out from later aligner experiments, a second tuning set next to dev.
- lang-<language>: evaluation sets for other languages, never assigned to train/dev/test.

Nothing ever moves between splits: `tst splits add` only assigns songs new in the library.
"""

import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from tunestudio_training import library, paths
from tunestudio_training.pipeline import ultrastar


def manifest_path() -> Path:
    """manifest.json, looked up when it's needed (so tests can point paths.SPLITS elsewhere)."""
    return paths.SPLITS / "manifest.json"


def songs(split: str, original: bool = False) -> list[str]:
    """A split's songs; `original`: only those assigned when the splits were made, before songs were added."""
    names = (paths.SPLITS / f"{split}.txt").read_text().splitlines()
    if not original:
        return names
    manifest = json.loads(manifest_path().read_text())["songs"]
    return [s for s in names if "added" not in manifest.get(s, {"added": True})]


def check_disjoint() -> None:
    """Refuse to go on if a dev or test song is in train, whatever happened to the split files."""
    train, dev, test = (set(songs(k)) for k in ("train", "dev", "test"))
    if (train | dev) & test or train & dev:
        raise SystemExit(f"split files overlap: {sorted(((train | dev) & test) | (train & dev))[:5]} ...")


def usable(folder: Path) -> Path | None:
    """The chart if the song can be used: one chart, single voice, no BPM changes, absolute times."""
    txts = list(folder.glob("*.txt"))
    if len(txts) != 1:
        return None
    raw = txts[0].read_bytes().decode("utf-8-sig", "replace")
    lines = raw.splitlines()
    if any(re.fullmatch(r"P\s*\d+", line.strip()) for line in lines) or any(line.startswith("B ") for line in lines):
        return None
    if "#RELATIVE:YES" in raw.upper():
        return None
    return txts[0]


def primary_artist(song: ultrastar.Song, folder: Path) -> str:
    artist = song.headers.get("ARTIST") or folder.name.split(" - ")[0]
    # "A feat. B", "A & B", "A x B", "A vs. B" -> A
    return re.split(r"\s+(?:feat\.?|ft\.?|featuring|&|x|vs\.?|und|and)\s+|,", artist, flags=re.I)[0].strip().lower()


def scan() -> dict[str, dict]:
    """Every usable song of the library except the language evaluation sets."""
    lang_sets = {s for f in paths.SPLITS.glob("lang-*.txt") for s in f.read_text().split("\n") if s}
    found: dict[str, dict] = {}
    for folder in library.folders():
        txt = usable(folder) if folder.name not in lang_sets else None
        if not txt:
            continue
        song = ultrastar.parse(txt)
        found[folder.name] = {
            "artist": primary_artist(song, folder),
            "language": song.headers.get("LANGUAGE", "").split(",")[0].strip().lower() or "unknown",
            "sha1": hashlib.sha1(txt.read_bytes()).hexdigest(),
        }
    return found


def add() -> None:
    """Assign songs new in the library without moving any existing one: a song by an artist already in test goes to
    test (no voice in two splits), everything else to train. Charts changed since splitting keep their split and are
    reported (rebuild the datasets that used them)."""
    manifest = json.loads(manifest_path().read_text())
    known = manifest["songs"]
    artist_split = {}
    for info in known.values():
        if info["split"] == "test" or info["artist"] not in artist_split:
            artist_split[info["artist"]] = info["split"]
    found = scan()
    added, changed = defaultdict(list), []
    stamp = datetime.now().isoformat(timespec="seconds")
    for name, info in found.items():
        if name in known:
            if known[name]["sha1"] != info["sha1"]:
                changed.append(name)
            continue
        split = "test" if artist_split.get(info["artist"]) == "test" else "train"
        known[name] = {**info, "split": split, "added": stamp}
        added[split].append(name)
    for split, names in added.items():
        (paths.SPLITS / f"{split}.txt").write_text("\n".join(sorted(songs(split) + names)) + "\n")
    manifest_path().write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    print("added:", {k: len(v) for k, v in added.items()} or "nothing new")
    if changed:
        print(f"{len(changed)} charts changed since splitting (kept their split):", changed[:10])
    gone = [n for n in known if n not in found]
    if gone:
        print(f"{len(gone)} split songs are not in the library (or not usable):", gone[:10])
