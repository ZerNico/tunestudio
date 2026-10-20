"""Slow checks on the real library, models and stems (`uv run pytest -m slow`): each skips with the reason when what
it needs isn't here. The settings come from the shell (TST_* variables, else training/tst.toml)."""

import filecmp
import json
import subprocess
import sys

import pytest

from tunestudio_training import chain, paths

pytestmark = pytest.mark.slow


def _tst(*args: str, **kw) -> subprocess.CompletedProcess:
    code = "import sys; from tunestudio_training.cli import main; sys.argv[0] = 'tst'; main()"
    return subprocess.run([sys.executable, "-c", code, *args], capture_output=True, text=True, **kw)


def _need(path, what: str):
    if not path.exists():
        pytest.skip(f"{what} not found at {path}")


def test_export_matches_shipped(real_data, tmp_path):
    for model in ("aligner", "boundary", "notefix", "ends"):
        _need(chain.shipped_checkpoint(model), f"the shipped {model}")
    r = _tst("export", "all", "--verify", "--out", str(tmp_path))  # without a notes dataset: refiners unchecked
    assert r.returncode == 0, r.stdout[-2000:] + r.stderr[-2000:]
    assert "model files identical to the shipped ones" in r.stdout


def test_eval_smoke(real_data, tmp_path, monkeypatch):
    from tunestudio_training import library, splits

    _need(paths.game() / "config.json", "GAME")
    _need(paths.aligner() / "config.json", "the aligner")
    song = splits.songs("dev")[0]  # what --limit 1 charts
    if not library.stems(song):
        pytest.skip(f"{song} (the first dev song) has no stems")
    monkeypatch.setenv("TST_RUNS", str(tmp_path))
    r = _tst("eval", "dev", "smoke", "--limit", "1")
    scores = tmp_path / "eval" / "dev" / "smoke" / song / "scores.json"
    assert r.returncode == 0 and scores.exists(), r.stdout[-2000:] + r.stderr[-2000:]
    row = json.loads(scores.read_text())
    assert 0 < row["note_f1"] <= 1


def test_fixtures_reproduce(real_data, tmp_path):
    """The app's tables reproduce from the library. The word-sampled fixtures only reproduce on the library they
    were made from."""
    if not any(r.is_dir() for r in paths.library_roots()):
        pytest.skip("no library")
    out = tmp_path / "charting"
    for args in (("syllables", "--out", str(out / "data")), ("fixtures", "--charting", str(out))):
        r = _tst(*args)
        assert r.returncode == 0, r.stderr[-2000:]
    for name in ("data/syllables-english.json", "data/syllables-german.json", "data/aligner-text.json",
                 "fixtures/numpy.json"):  # fmt: skip
        assert filecmp.cmp(out / name, paths.CHARTING / name, shallow=False), name
    sampled = [n for n in ("fixtures/syllables.json", "fixtures/aligner-text.json")
               if not filecmp.cmp(out / n, paths.CHARTING / n, shallow=False)]  # fmt: skip
    if sampled:
        pytest.xfail(f"{', '.join(sampled)} sampled from another library than the committed ones")


@pytest.mark.mps
def test_train_mps_parity(tmp_path, capsys):
    """§6 step 2: the tiny aligner and head trained on the CPU and on MPS with the same seed and batches agree."""
    import torch

    if not torch.backends.mps.is_available():
        pytest.skip("no MPS")
    pytest.importorskip("transformers")
    from test_aligner_train import losses, make_tiny_clips

    make_tiny_clips(tmp_path)
    from tunestudio_training import aligner

    curves = {}
    for dev in ("cpu", "mps"):
        aligner.train_aligner(tmp_path / f"a-{dev}", steps=20, lr=1e-3, max_seconds=4, device=dev, seed=0, log_every=1)
        curves[dev] = losses(capsys.readouterr().out)
    cpu, mps = curves["cpu"], curves["mps"]
    assert len(cpu) == len(mps) == 20
    assert mps[0] == pytest.approx(cpu[0], rel=1e-4)
    assert mps == pytest.approx(cpu, rel=1e-3)
    heads = {}
    for dev in ("cpu", "mps"):
        aligner.train_boundary(tmp_path / "tiny", tmp_path / f"b-{dev}.pt", steps=40, lr=1e-3, batch=4, device=dev,
                               seed=0, log_every=1)  # fmt: skip
        heads[dev] = losses(capsys.readouterr().out)
    assert heads["mps"] == pytest.approx(heads["cpu"], rel=1e-3)
