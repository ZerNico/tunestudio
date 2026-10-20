"""Vocal stems and pitch tracks for the songs of some splits, into `<TST_DATA>/stems/<song>/` (resumable). Every
dataset and evaluation starts from these. One process per song (torch memory grows in long-lived processes); the
instrumental is not kept. Songs that already have stems in a TST_STEMS folder are skipped."""

import subprocess
import sys
import time
from pathlib import Path

from tunestudio_training import library, paths, progress, splits
from tunestudio_training.pipeline import stems as make_stems

SECONDS_PER_SONG = 40  # on an M-series Mac, for estimates


def prepare(names: list[str], part: str | None = None) -> None:
    """Stems for the songs of the splits `names`; `part` "i/n" takes every n-th song from i."""
    prepare_songs(progress.select([s for name in names for s in splits.songs(name)], part))


def prepare_songs(songs: list[str]) -> None:
    out = paths.data() / "stems"
    todo = [s for s in songs if not library.stems(s)]
    print(f"{len(songs) - len(todo)} of {len(songs)} songs have stems already", flush=True)
    bar = progress.Progress(len(todo))
    for i, song in enumerate(todo):
        start = time.time()
        args = [sys.executable, "-m", "tunestudio_training.stems", str(library.folder(song)), str(out / song)]
        r = subprocess.run(args, capture_output=True, text=True)
        status = "ok" if library.stems(song) else progress.failure(out / song, r.stderr)
        bar.done(i, song, status, time.time() - start)
    if todo:
        bar.summary()


if __name__ == "__main__":  # one song, in its own process (see `prepare`)
    audio = library.find_files(Path(sys.argv[1]))[1]
    make_stems(str(audio), Path(sys.argv[2]), keep_instrumental=False)
