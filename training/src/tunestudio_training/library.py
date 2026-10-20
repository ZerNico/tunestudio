"""The song library: hand-made UltraStar charts with their audio, one folder per song ("Artist - Title"), possibly
spread over several roots (TST_LIBRARY), for example a USDB Syncer library plus extra songs. Folder names are unique
across roots; the first root that has a song wins."""

from collections.abc import Iterator
from pathlib import Path

from tunestudio_training import paths
from tunestudio_training.pipeline import ultrastar

AUDIO_EXTS = (".opus", ".m4a", ".mp3", ".ogg", ".flac", ".wav", ".webm")


def folder(song: str) -> Path:
    roots = paths.library_roots()
    return next((root / song for root in roots if (root / song).is_dir()), roots[0] / song)


def folders() -> Iterator[Path]:
    """Song folders of all roots, sorted by name within each root."""
    seen = set()
    for root in paths.library_roots():
        for p in sorted(root.iterdir()) if root.is_dir() else []:
            if p.is_dir() and p.name not in seen:
                seen.add(p.name)
                yield p


def chart(song: str) -> Path | None:
    return next(folder(song).glob("*.txt"), None)


def find_files(song_folder: Path) -> tuple[Path, Path]:
    """The folder's chart and the audio it names (#AUDIO or #MP3), or else the first audio file."""
    txt = next(p for p in song_folder.glob("*.txt"))
    song = ultrastar.parse(txt)
    name = song.headers.get("AUDIO") or song.headers.get("MP3")
    audio = (
        song_folder / name
        if name and (song_folder / name).exists()
        else next(p for p in song_folder.iterdir() if p.suffix in AUDIO_EXTS)
    )
    return txt, audio


def stems(song: str) -> Path | None:
    """The folder with the song's vocal stem and pitch track (`tst stems`), if it has them."""
    return next(
        (
            d / song
            for d in paths.stem_dirs()
            if (d / song / "vocals.flac").exists() and (d / song / "pitch.npz").exists()
        ),
        None,
    )
