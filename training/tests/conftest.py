"""Shared fixtures. Every test runs isolated: no TST_* variable from the shell, a config file and data folders of its
own in a temp folder, Hugging Face offline and no network at all. Builders make small songs, charts and stems, so no
test needs the real library, models or a separation run.
"""

import json
import os
import shutil
import socket
import sys
from pathlib import Path

import numpy as np
import pytest

from tunestudio_training import config, paths

SR = 44100
# The shell's settings, for the slow tests that use the real library, models and stems (`real_data`).
REAL_ENV = {k: v for k, v in os.environ.items() if k.startswith("TST_")}
REAL_CONNECT = socket.socket.connect


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A clean environment per test: folders under tmp_path, an empty config file, offline."""
    for key in list(os.environ):
        if key.startswith("TST_"):
            monkeypatch.delenv(key)
    cfg = tmp_path / "tst.toml"
    cfg.write_text("")
    monkeypatch.setenv("TST_CONFIG", str(cfg))
    for key, name in (("TST_DATA", "data"), ("TST_RUNS", "runs"), ("TST_MODELS", "models"), ("TST_LIBRARY", "library")):
        (tmp_path / name).mkdir()
        monkeypatch.setenv(key, str(tmp_path / name))
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "1")

    def no_network(self, address):
        if self.family == getattr(socket, "AF_UNIX", None):
            return REAL_CONNECT(self, address)
        raise OSError(f"tests don't use the network (tried {address})")

    monkeypatch.setattr(socket.socket, "connect", no_network)
    _clear_caches()
    yield
    _clear_caches()


def _clear_caches() -> None:
    config.cache_clear()
    for module, names in (
        ("tunestudio_training.pipeline.align", ("_model", "_tokenizer", "emissions")),
        ("tunestudio_training.pipeline.notefix", ("load",)),
        ("tunestudio_training.pipeline.game", ("model",)),
        ("tunestudio_training.pipeline.onnx_models", ("session", "_aligner_outputs")),
        ("tunestudio_training.pipeline.lyrics", ("_syllabifier",)),
        ("tunestudio_training.pipeline.boundary", ("_load", "probabilities")),
    ):
        if module in sys.modules:
            for name in names:
                getattr(sys.modules[module], name).cache_clear()


@pytest.fixture
def real_data(monkeypatch: pytest.MonkeyPatch):
    """The settings the shell had (TST_* variables, else training/tst.toml): for the slow tests."""
    for key in list(os.environ):
        if key.startswith("TST_"):
            monkeypatch.delenv(key)
    for key, value in REAL_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(socket.socket, "connect", REAL_CONNECT)
    _clear_caches()


needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg on PATH")


def chart_text(
    notes: list[list[tuple]],
    bpm: float = 300,
    gap: float = 1000,
    language: str = "English",
    headers: dict[str, str] | None = None,
    duet: bool = False,
) -> str:
    """An UltraStar chart: `notes` is lines of (type char, start, length, pitch, text)."""
    head = {"TITLE": "Song", "ARTIST": "Artist", "BPM": str(bpm), "GAP": str(gap), "LANGUAGE": language}
    lines = [f"#{k}:{v}" for k, v in {**head, **(headers or {})}.items()]
    voices = [notes, notes] if duet else [notes]
    for v, phrases in enumerate(voices):
        if duet:
            lines.append(f"P{v + 1}")
        for j, phrase in enumerate(phrases):
            if j:
                lines.append(f"- {phrase[0][1] - 2}")
            lines += [f"{t} {s} {n} {p} {text}" for t, s, n, p, text in phrase]
    return "\n".join(lines + ["E"]) + "\n"


def write_chart(folder: Path, notes: list[list[tuple]], name: str | None = None, **kwargs) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{name or folder.name}.txt"
    path.write_text(chart_text(notes, **kwargs), encoding="utf8")
    return path


SIMPLE = [
    [(":", 0, 4, 0, "Hel"), (":", 4, 4, 2, "lo "), (":", 8, 8, 4, "world ")],
    [(":", 24, 4, 5, "sing "), (":", 28, 4, 7, "a~"), (":", 32, 4, 9, "~ "), (":", 36, 6, 7, "song ")],
]


def sine(seconds: float = 2.0, freq: float = 440.0, sr: int = SR) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def write_song(root: Path, name: str, notes: list[list[tuple]] | None = None, seconds: float = 2.0, **kwargs) -> Path:
    """A library song: its chart and a sine as FLAC."""
    import soundfile as sf

    folder = root / name
    write_chart(folder, notes or SIMPLE, headers={"AUDIO": "song.flac"}, **kwargs)
    sf.write(folder / "song.flac", sine(seconds), SR)
    return folder


def write_stems(folder: Path, midi: np.ndarray, hop: float = 0.01) -> Path:
    """`vocals.flac` (a sine) and a pitch track with the given MIDI per 10 ms frame (NaN = unvoiced)."""
    import soundfile as sf

    folder.mkdir(parents=True, exist_ok=True)
    sf.write(folder / "vocals.flac", sine(len(midi) * hop), SR)
    rms = np.where(np.isnan(midi), -60.0, -10.0)
    np.savez(folder / "pitch.npz", times=np.arange(len(midi)) * hop, midi=np.asarray(midi, float), rms=rms)
    return folder


@pytest.fixture
def tiny_splits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Splits of our own: `make({"train": [...], ...}, manifest={...})` writes them and points paths.SPLITS there."""
    folder = tmp_path / "splits"
    folder.mkdir()
    monkeypatch.setattr(paths, "SPLITS", folder)

    def make(lists: dict[str, list[str]], manifest: dict[str, dict] | None = None) -> Path:
        for split, songs in lists.items():
            (folder / f"{split}.txt").write_text("".join(f"{s}\n" for s in songs))
        if manifest is None:
            manifest = {
                s: {"artist": s.split(" - ")[0].lower(), "language": "english", "sha1": "0", "split": split}
                for split, songs in lists.items()
                if not split.startswith("lang-")
                for s in songs
            }
        (folder / "manifest.json").write_text(json.dumps({"songs": manifest}, indent=1))
        return folder

    return make
