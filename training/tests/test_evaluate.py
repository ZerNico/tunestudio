import json

import numpy as np
import pytest

from tunestudio_training import chain, evaluate, paths
from tunestudio_training.pipeline import ultrastar

from conftest import SIMPLE, write_chart, write_stems


def test_wer_and_words():
    assert evaluate._words("Don’t STOP, me-now!") == ["don't", "stop", "me", "now"]
    assert evaluate._wer(["a", "b", "c"], ["a", "b", "c"]) == 0
    assert evaluate._wer(["a", "b", "c"], ["a", "x", "c", "d"]) == pytest.approx(2 / 3)
    assert evaluate._wer([], []) == 0 and evaluate._wer([], ["a"]) == 1


def test_chart_lines(tmp_path):
    lines = evaluate.chart_lines(ultrastar.parse(write_chart(tmp_path / "S", SIMPLE)))
    assert [x.text for x in lines] == ["Hello world", "sing a song"]
    assert lines[0].start is None


def _run(name: str, values: dict[str, float], language: str = "English") -> None:
    for song, v in values.items():
        d = chain.run_dir("dev", name) / song
        d.mkdir(parents=True)
        row = {m: v for m in evaluate.METRICS} | {"language": language}
        (d / "scores.json").write_text(json.dumps(row))


def test_compare_marks_clear_differences(capsys):
    songs = [f"S - {i}" for i in range(12)]
    _run("a", {s: 0.5 for s in songs})
    _run("b", {s: 0.6 + 0.001 * i for i, s in enumerate(songs)} | {"Extra - 1": 0.1})
    evaluate.compare("dev", "a", "b", by_language=True)
    out = capsys.readouterr().out
    assert "12 songs paired, 1 unpaired" in out
    frame = next(line for line in out.splitlines() if line.startswith("frame_f1"))
    assert "*" in frame and "<- primary" in frame and "12/0" in frame
    assert "English (12 songs)" in out


def test_compare_leaves_out_songs_without_golden_notes(capsys):
    songs = [f"S - {i}" for i in range(12)]
    _run("a", {s: 0.5 for s in songs})
    _run("b", {s: 0.6 for s in songs})
    for s in songs[:4]:  # charts without golden notes: no golden scores in either run
        for name in ("a", "b"):
            path = chain.run_dir("dev", name) / s / "scores.json"
            path.write_text(json.dumps(json.loads(path.read_text()) | {"golden_f1": float("nan")}))
    evaluate.compare("dev", "a", "b")
    out = capsys.readouterr().out
    golden = next(line for line in out.splitlines() if line.startswith("golden_f1"))
    assert "nan" not in golden and "8/0" in golden and "(8 songs)" in golden


def test_compare_needs_both_runs():
    _run("a", {"S - 1": 0.5})
    with pytest.raises(chain.Missing) as e:
        evaluate.compare("dev", "a", "nope")
    assert "tst eval dev nope" in str(e.value)


def test_prepare_links_stems_and_shares_caches(tmp_path):
    stem = write_stems(paths.data() / "stems" / "S - 1", np.full(100, 60.0))
    (stem / "lrclib.json").write_text("[]")
    sib = chain.run_dir("dev", "other") / "S - 1"
    sib.mkdir(parents=True)
    for f in ("beats.npz", "align-abc.json", "whisper.json"):
        (sib / f).write_text("x")
    work = chain.run_dir("dev", "new") / "S - 1"
    assert evaluate._prepare(work, [sib], onnx=False)
    assert (work / "vocals.flac").is_symlink() and (work / "pitch.npz").resolve() == (stem / "pitch.npz").resolve()
    assert sorted(p.name for p in work.iterdir()) == [
        "align-abc.json", "beats.npz", "lrclib.json", "pitch.npz", "vocals.flac", "whisper.json"
    ]  # fmt: skip
    assert not evaluate._prepare(chain.run_dir("dev", "new") / "No stems", [], onnx=False)


def test_run_checks_models_before_starting(tiny_splits):
    tiny_splits({"dev": ["S - 1"]})
    with pytest.raises(chain.Missing) as e:
        evaluate.run("dev", "x", {})
    assert "GAME" in str(e.value)
    assert not chain.run_dir("dev", "x").exists()
