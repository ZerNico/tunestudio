"""Nothing that can hold lyrics, audio or weights goes into git (CI runs this on every change to training/)."""

import shutil
import subprocess

import pytest

from tunestudio_training import paths

FORBIDDEN = (".wav", ".flac", ".opus", ".mp3", ".m4a", ".ogg", ".onnx", ".pt", ".pkl", ".npz", ".safetensors", ".bin")


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=paths.TRAINING, capture_output=True, text=True)


@pytest.fixture(scope="module")
def in_git():
    if shutil.which("git") is None or _git("rev-parse", "--git-dir").returncode != 0:
        pytest.skip("not in a git checkout")


def test_no_data_in_git(in_git):
    files = _git("ls-files", "--cached", "--others", "--exclude-standard", ".").stdout.splitlines()
    assert not [f for f in files if f.lower().endswith(FORBIDDEN)]
    # Charts are .txt: only the split lists may be text files here.
    assert not [f for f in files if f.endswith(".txt") and not f.startswith("splits/")]


@pytest.mark.parametrize("path", [".local/x", ".local/data/stems/song/vocals.flac", "tst.toml"])
def test_local_files_are_ignored(in_git, path):
    assert _git("check-ignore", "-q", path).returncode == 0, path
