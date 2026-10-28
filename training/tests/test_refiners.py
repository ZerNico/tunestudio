import json
import pickle

import numpy as np
import pytest

from tunestudio_training import chain, export, metrics, paths, refiners
from tunestudio_training import golden as golden_training
from tunestudio_training.pipeline import golden, notefix, ultrastar

from conftest import write_song


def _synthetic(path, songs: int = 20, per_song: int = 15, seed: int = 0):
    """A notes dataset with learnable labels: the pitch shift is the rounded first feature."""
    rng = np.random.default_rng(seed)
    n = songs * per_song
    X = rng.standard_normal((n, 24)).astype(np.float32)
    y = np.clip(np.round(X[:, 0]), -2, 2).astype(np.int8)
    song = np.repeat(np.arange(songs), per_song).astype(np.int32)
    start = np.tile(np.arange(per_song, dtype=np.float32), songs)
    delta = (0.1 * X[:, 1]).astype(np.float32)
    delta[::5] = np.nan
    np.savez_compressed(
        path, X=X, y=y, ref=np.zeros(n, np.int16), song=song, feature_names=np.array(notefix.FEATURES),
        songs=np.array([f"S - {i}" for i in range(songs)]), all_X=X, all_start=start, all_end=start + 0.5,
        all_hit=~np.isnan(delta), all_song=song, all_end_delta=delta,
    )  # fmt: skip
    return path


def test_held_out_is_deterministic():
    song = np.repeat(np.arange(40), 3)
    a, b = refiners._held_out(song), refiners._held_out(song)
    assert np.array_equal(a, b) and len(np.unique(song[a])) == 6  # 15% of 40 songs, whole songs


def test_dataset_labels_dumped_notes(capsys):
    write_song(paths.library_roots()[0], "S - 1")
    chart = ultrastar.parse(paths.library_roots()[0] / "S - 1" / "S - 1.txt")
    work = chain.run_dir("train", "dump") / "S - 1"
    work.mkdir(parents=True)
    n = 1000
    midi = metrics._frames(chart, n)
    np.savez(work / "pitch.npz", times=np.arange(n) * 0.01, midi=midi, rms=np.zeros(n))
    notes = [
        {
            "start": chart.beat_to_sec(x.start),
            "end": chart.beat_to_sec(x.start + x.length),
            "midi": x.midi + d,
            "x": [0.0] * 24,
        }
        for x, d in zip(chart.notes(), [0, 1, -1, 2, 0, 0, 0])
    ] + [{"start": 9.0, "end": 9.5, "midi": 60, "x": [1.0] * 24}]
    (work / "notes.json").write_text(json.dumps(notes))
    out = paths.data() / "notes" / "notes.npz"
    refiners.dataset([chain.dump_run()], out)
    d = np.load(out)
    assert list(d["songs"]) == ["S - 1"] and len(d["all_X"]) == 8
    # The offset search can't line up a track made from the chart exactly (SCOOP_BIAS), so labels are close.
    assert len(d["y"]) >= 6 and d["all_hit"].sum() >= 6 and not d["all_hit"][-1]


def test_dataset_needs_dumped_notes():
    chain.dump_run().mkdir(parents=True)
    with pytest.raises(chain.Missing, match="--dump-notes"):
        refiners.dataset([chain.dump_run()], paths.data() / "x.npz")
    with pytest.raises(chain.Missing, match="tst eval train dump"):
        refiners.dataset([chain.run_dir("train", "nope")], paths.data() / "x.npz")


def test_training_and_export_are_reproducible(tmp_path, capsys):
    from threadpoolctl import threadpool_limits

    data = _synthetic(tmp_path / "notes.npz")
    with threadpool_limits(1):  # tiny data: threads only cost time (a lot on a busy machine)
        for k in (1, 2):
            refiners.train_notefix(data, tmp_path / f"nf{k}.pkl")
            refiners.train_ends(data, tmp_path / f"e{k}.pkl")
    assert (tmp_path / "nf1.pkl").read_bytes() == (tmp_path / "nf2.pkl").read_bytes()
    assert (tmp_path / "e1.pkl").read_bytes() == (tmp_path / "e2.pkl").read_bytes()
    out = capsys.readouterr().out
    assert "held-out" in out and "within ±100ms" in out

    rng = np.random.default_rng(0)
    G = rng.normal(size=(2000, len(golden.FEATURES)))  # scored as float32 below, near the splits
    gy = (G[:, 0] + rng.normal(size=len(G)) > 1).astype(np.int8)
    (tmp_path / "g1.pkl").write_bytes(pickle.dumps(golden_training._fit([{"X": G, "y": gy}], linear=False)))
    for k in (1, 2):
        export.export_refiners(
            tmp_path / f"x{k}", tmp_path / "nf1.pkl", tmp_path / "e1.pkl", tmp_path / "g1.pkl", data, []
        )
    for name in ("notefix.onnx", "ends.onnx", "golden.onnx", "notefix.json"):
        assert (tmp_path / "x1" / name).read_bytes() == (tmp_path / "x2" / name).read_bytes(), name
    nf = pickle.loads((tmp_path / "nf1.pkl").read_bytes())
    X = np.load(data)["all_X"]
    proba = export.session(tmp_path / "x1" / "notefix.onnx").run(None, {"features": X})[1]
    np.testing.assert_allclose(proba, nf.predict_proba(X), atol=1e-5)
    G = G.astype(np.float32)
    proba = export.session(tmp_path / "x1" / "golden.onnx").run(["probabilities"], {"features": G})[0]
    ref = golden.probabilities(golden.load_model(tmp_path / "g1.pkl"), G)
    np.testing.assert_allclose(proba[:, 1], ref, atol=1e-5)
    assert json.loads((tmp_path / "x1" / "notefix.json").read_text()) == {
        "classes": [-2, -1, 0, 1, 2],
        "threshold": 0.5,
    }


def test_training_needs_the_dataset(tmp_path):
    with pytest.raises(chain.Missing, match="tst dataset notes"):
        refiners.train_notefix(tmp_path / "none.npz", tmp_path / "nf.pkl")
