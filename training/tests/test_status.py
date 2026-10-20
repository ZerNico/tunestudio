import json

import numpy as np

from tunestudio_training import chain, paths, status

from conftest import write_stems


def test_status_rows_and_next_steps(tiny_splits, capsys, monkeypatch):
    tiny_splits({"train": ["A - 1", "A - 2"], "dev": ["B - 1"], "test": [], "sel": ["A - 1"]})
    (paths.library_roots()[0] / "A - 1").mkdir()
    (paths.library_roots()[0] / "New - 1").mkdir()
    write_stems(paths.data() / "stems" / "A - 1", np.full(10, 60.0))
    for subset in ("train", "valid"):
        (chain.clips_dir() / subset).mkdir(parents=True)
        (chain.clips_dir() / subset / "index.txt").write_text("a\nb\n")
        (chain.clips_dir() / subset / "songs.json").write_text(json.dumps({"songs": {"A - 1": {}}}))
    (chain.clips_dir() / "build.json").write_text(
        json.dumps({"limit": 1, "splits_manifest_sha1": chain.manifest_sha1()})
    )
    chain.aligner_data().mkdir(parents=True)
    chain.targets_path().write_text("{}")
    (paths.models() / "aligner" / "aligner-ft2").mkdir(parents=True)
    (paths.models() / "aligner" / "aligner-ft2" / "config.json").write_text("{}")
    (paths.models() / "notefix").mkdir()
    (paths.models() / "notefix" / "nf4.pkl").write_bytes(b"")
    (chain.run_dir("dev", "base") / "B - 1").mkdir(parents=True)
    (chain.run_dir("dev", "base") / "B - 1" / "scores.json").write_text("{}")
    status.status()
    out = capsys.readouterr().out
    rows = {line.split()[0]: line for line in out.splitlines() if line and not line.startswith(" ")}
    assert "2 songs, 1 folders not in the splits" in rows["library"]
    assert "train 1/2  dev 0/1  test 0/0  sel 1/1" in rows["stems"]
    assert "clips: 1 train songs, 2 clips" in rows["datasets"] and "smoke build" in rows["datasets"]
    assert "targets ok" in rows["datasets"] and "boundaries missing" in rows["datasets"]
    assert "aligner-ft2 (shipped, pipeline)" in rows["models"] and "nf4 (shipped)" in rows["models"]
    assert "GAME missing" in rows["models"]
    assert "eval/dev: base 1/1" in rows["runs"]
    assert "0/4 repos" in rows["exports"]
    nxt = out.split("next\n")[1]
    assert "aligner    clips stale: a smoke build (--limit 1): tst dataset clips" in nxt
    assert "boundaries missing: tst dataset boundary" in nxt
    assert "notefix    dump missing: tst eval train dump --dump-notes" in nxt


def test_doctor_flags_problems(monkeypatch, capsys):
    monkeypatch.setenv("PATH", "")
    monkeypatch.setenv("TST_DATAS", "typo")
    assert status.doctor() == 1
    out = capsys.readouterr().out
    assert "PROBLEM ffmpeg: not on PATH" in out
    assert "PROBLEM unknown variables (typos?): TST_DATAS" in out
    assert "PROBLEM GAME" in out
