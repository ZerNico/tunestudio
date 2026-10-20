import os
from pathlib import Path

import numpy as np

from tunestudio_training import library, paths

from conftest import SIMPLE, write_chart, write_stems


def _roots(tmp_path, monkeypatch, *names):
    roots = [tmp_path / n for n in names]
    for r in roots:
        r.mkdir(exist_ok=True)
    monkeypatch.setenv("TST_LIBRARY", os.pathsep.join(map(str, roots)))
    return roots


def test_first_root_wins_and_folders_dedupe(tmp_path, monkeypatch):
    a, b = _roots(tmp_path, monkeypatch, "a", "b")
    write_chart(a / "X - 1", SIMPLE)
    write_chart(b / "X - 1", SIMPLE)
    write_chart(b / "Y - 1", SIMPLE)
    write_chart(a / "Z - 1", SIMPLE)
    assert library.folder("X - 1") == a / "X - 1"
    assert library.folder("Y - 1") == b / "Y - 1"
    assert library.folder("Nope") == a / "Nope"  # where a new song would go
    assert [p.parent.name + "/" + p.name for p in library.folders()] == ["a/X - 1", "a/Z - 1", "b/Y - 1"]
    assert library.chart("Y - 1") == b / "Y - 1" / "Y - 1.txt"
    assert library.chart("Nope") is None


def test_find_files_prefers_audio_then_mp3_then_any(tmp_path):
    folder = tmp_path / "S"
    write_chart(folder, SIMPLE)
    for f in ("a.ogg", "b.mp3", "c.opus", "notes.pdf"):
        (folder / f).write_bytes(b"")
    assert library.find_files(folder)[1].suffix in (".ogg", ".mp3", ".opus")
    write_chart(folder, SIMPLE, headers={"MP3": "b.mp3"})
    assert library.find_files(folder)[1] == folder / "b.mp3"
    write_chart(folder, SIMPLE, headers={"MP3": "b.mp3", "AUDIO": "c.opus"})
    assert library.find_files(folder) == (folder / "S.txt", folder / "c.opus")
    write_chart(folder, SIMPLE, headers={"AUDIO": "missing.opus"})
    assert library.find_files(folder)[1].suffix in (".ogg", ".mp3", ".opus")


def test_stems_need_both_files_and_search_every_folder(tmp_path, monkeypatch):
    extra = tmp_path / "extra"
    monkeypatch.setenv("TST_STEMS", str(extra))
    assert library.stems("S") is None
    (paths.data() / "stems" / "S").mkdir(parents=True)
    (paths.data() / "stems" / "S" / "vocals.flac").write_bytes(b"")
    assert library.stems("S") is None  # no pitch track yet
    write_stems(extra / "S", np.full(10, 60.0))
    assert library.stems("S") == extra / "S"
    write_stems(paths.data() / "stems" / "S", np.full(10, 60.0))
    assert library.stems("S") == paths.data() / "stems" / "S"
    assert isinstance(library.stems("S"), Path)
