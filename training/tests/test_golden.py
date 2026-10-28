import copy
import json

import numpy as np
import pytest

from tunestudio_training import golden as golden_training
from tunestudio_training.pipeline import chart, golden
from tunestudio_training.pipeline.pitch import PitchTrack
from tunestudio_training.pipeline.ultrastar import Note, Song

GRID = chart.Grid(bpm=300, gap=0.0)  # a beat is 50 ms
FE = golden.FEATURES


def _song() -> tuple[list[list[Note]], PitchTrack]:
    """20 lines: three short notes, a melisma "hold ~ ~" peaking in its middle, a rest, and a long last note. A pitch
    track singing every note on pitch, the long ones louder."""
    lines = []
    for li in range(20):
        s = li * 100
        lines.append([
            Note("normal", s, 4, 0, "one "), Note("normal", s + 5, 4, 2, "two "),
            Note("normal", s + 10, 4, 1, "three "),
            Note("normal", s + 15, 4, 5, "hold"), Note("normal", s + 19, 4, 9, "~"), Note("normal", s + 23, 4, 4, "~ "),
            Note("normal", s + 40, 20, 3, "end "),
        ])  # fmt: skip
    n = 20 * 100 * 5 + 200
    times = np.arange(n) * 0.01
    midi, rms = np.full(n, np.nan), np.full(n, -60.0)
    for line in lines:
        for note in line:
            a, b = int(GRID.to_sec(note.start) * 100), int(GRID.to_sec(note.start + note.length) * 100)
            midi[a:b], rms[a:b] = note.midi, (-20.0 if note.length > 10 else -30.0)
    return lines, PitchTrack(times, midi, rms)


def _table(tmp_path, weights: dict[str, float], intercept: float, **pick) -> str:
    """A model table with single-feature terms and these weights (the rest 0), unstandardized."""
    coef = [weights.get(f, 0.0) for f in FE]
    table = {
        "features": list(FE), "terms": [[f] for f in FE], "mean": [0.0] * len(FE), "scale": [1.0] * len(FE),
        "coef": coef, "intercept": intercept, "pick": {**golden.PICK, **pick},
    }  # fmt: skip
    path = tmp_path / "g.json"
    path.write_text(json.dumps(table))
    return str(path)


def test_features_see_lines_phrases_and_melismas():
    lines, track = _song()
    X = golden.features(lines, GRID, track, 0.0)
    assert X.shape == (140, len(FE)) and np.isfinite(X).all()
    col = lambda k, name: X[k, FE.index(name)]  # noqa: E731
    # the 0.85 s rest before "end" splits the line into two phrases, the line is still one
    assert col(5, "phrase_last") == 1 and col(6, "phrase_first") == 1 and col(6, "phrase_last") == 1
    assert col(5, "line_last") == 0 and col(6, "line_last") == 1 and col(6, "line_from_end") == 0
    assert col(4, "phrase_peak") == 1 and col(4, "line_peak") == 1 and col(0, "below_phrase_peak") == 9
    assert col(6, "sec") == pytest.approx(1.0) and col(6, "on_pitch") == pytest.approx(1.0, abs=0.02)
    assert col(6, "loud") == pytest.approx(10) and col(0, "loud") == 0 and col(6, "len_rank") > 0.9
    assert col(3, "mel_size") == 3 and col(4, "tilde") == 1 and col(4, "mel_index") == 1 and col(4, "mel_range") == 5
    assert col(3, "word_end") == 0 and col(5, "word_end") == 1 and col(0, "word_end") == 1
    s = golden.structure(lines, GRID)
    assert s["melisma"][3] == s["melisma"][4] == s["melisma"][5] != s["melisma"][2]
    assert s["phrase"][6] == s["phrase"][5] + 1 and s["line"][6] == s["line"][5]


def test_no_loudness_track_and_no_notes():
    lines, track = _song()
    X = golden.features(lines, GRID, PitchTrack(track.times, track.midi, None), 0.0)
    assert np.isfinite(X).all() and not X[:, FE.index("loud")].any()
    assert golden.features([[]], GRID, track, 0.0).shape == (0, len(FE))


def test_rule_method_is_mark_golden():
    lines, track = _song()
    shipped = copy.deepcopy(lines)
    chart.mark_golden(shipped, GRID, track)
    lines[0][0].type = "golden"  # replaced, not kept
    golden.mark(lines, GRID, track, 0.0, {"method": "rule"})
    assert [n.type for line in lines for n in line] == [n.type for line in shipped for n in line]
    with pytest.raises(ValueError):
        golden.mark(lines, GRID, track, 0.0, {"method": "nope"})


def _structure(n: int, melisma=None, line=None, text=None) -> dict[str, np.ndarray]:
    """`structure` of n notes a second apart (so note k is at k / n of the song), one melisma and line each unless
    given, every line's lyrics different unless given."""
    line = np.arange(n) if line is None else np.asarray(line)
    return {
        "start": np.arange(n, dtype=float), "end": np.arange(n) + 1.0,
        "melisma": np.arange(n) if melisma is None else np.asarray(melisma), "line": line,
        "text": line if text is None else np.asarray(text),
    }  # fmt: skip


def test_pick_takes_the_expected_number():
    s = _structure(100)
    proba = np.full(100, 0.02)  # sum 2
    proba[[10, 40, 70]] = [0.9, 0.8, 0.7]  # sum 4.36: four notes
    picked = golden.pick(proba, s)
    assert len(picked) == 4 and {10, 40, 70} <= set(picked.tolist())
    assert len(golden.pick(proba, s, scale=0.5)) == 2
    assert len(golden.pick(np.full(100, 0.004), s)) == 0  # nothing stands out: no golden notes
    assert golden.pick(proba, s, start="syllable").tolist() == picked.tolist()  # no melismas: the same
    with pytest.raises(ValueError):
        golden.pick(proba, s, start="nope")


def test_pick_runs_take_likely_melismas():
    s = _structure(100, melisma=np.repeat(np.arange(50), 2))  # 50 melismas of 2 notes
    proba = np.full(100, 0.0)
    proba[[10, 11, 40, 41]] = [0.9, 0.9, 0.85, 0.1]  # sum 2.75: three notes
    assert golden.pick(proba, s).tolist() == [10, 11, 40]
    # 10's melisma is as likely as 10 (taken whole), 40's isn't: 40 alone, 41 never
    assert golden.pick(proba, s, runs=1.0).tolist() == [10, 11, 40]
    proba[11] = 0.5  # 10's melisma (mean 0.7) is now less likely than 10 itself: 10 alone first
    assert 41 not in golden.pick(proba, s, runs=1.0).tolist()


def test_pick_from_the_syllable_keeps_melismas_together():
    s = _structure(100, melisma=np.repeat(np.arange(25), 4))  # 25 melismas "hold ~ ~ ~"
    proba = np.full(100, 0.0)
    proba[[20, 21, 22, 23]] = [0.2, 0.3, 0.9, 0.2]  # only its third note stands out: sum 1.6, two notes
    assert golden.pick(proba, s, start="any").tolist() == [21, 22]  # two "~" without their syllable
    # from the syllable: its first three notes have the best mean (0.47), the fourth would drop it to 0.4
    assert golden.pick(proba, s, start="syllable", runs=None).tolist() == [20, 21, 22]
    assert golden.pick(proba, s, start="syllable", runs=0.8).tolist() == [20, 21, 22, 23]  # 0.4 >= 0.8 * 0.47
    proba[[60, 61, 62, 63]] = [0.9, 0.1, 0.1, 0.1]  # a melisma whose syllable alone stands out: sum 2.8, three notes
    # 60 alone first (0.9), then the first melisma whole (0.4), not cut at the number
    assert golden.pick(proba, s, start="syllable", runs=0.7).tolist() == [20, 21, 22, 23, 60]
    picked = golden.pick(np.random.default_rng(0).random(100), s, start="syllable", runs=0.7)
    starts = {int(k) for k in picked if k == 0 or k - 1 not in picked}
    assert all(k % 4 == 0 for k in starts)  # every golden group starts on a syllable


def test_pick_spreads_over_the_song():
    s = _structure(100)
    proba = np.where(np.arange(100) < 10, 0.9, 0.01)  # the likely ones all in the first tenth: 10 golden notes
    picked = golden.pick(proba, s, spread=0.25)
    assert len(picked) == 10 and np.sum(picked < 10) == 3  # at most ceil(0.25 * 10) per tenth


def test_pick_caps_repeated_lines():
    s = _structure(100, line=np.repeat(np.arange(20), 5), text=np.repeat(np.arange(20) % 4, 5))  # 4 lyrics, 5 times
    proba = np.full(100, 0.0)
    proba[np.arange(20) * 5 + 4] = np.where(np.arange(20) % 4 == 0, 0.9, 0.5)  # lyrics 0's last note likelier
    picked = golden.pick(proba, s, repeat_cap=2)
    gilded = {int(s["line"][k]) for k in picked}
    assert sum(li % 4 == 0 for li in gilded) == 2 and len(picked) == 12  # the other 10 from the other lyrics
    assert sum(int(s["line"][k]) % 4 == 0 for k in golden.pick(proba, s)) == 5


def test_structure_finds_repeated_lyrics():
    lines = [
        [Note("normal", 0, 4, 0, "Wann "), Note("normal", 5, 4, 0, "Mann?"), Note("normal", 9, 4, 0, "~ ")],
        [Note("normal", 20, 4, 0, "oh")],
        [Note("normal", 40, 4, 0, "wann "), Note("normal", 45, 8, 0, "Mann? ")],
        [Note("normal", 60, 4, 0, "oh")],
    ]  # fmt: skip
    assert golden.lyrics_key(lines[0]) == golden.lyrics_key(lines[2]) == "wannmann"
    s = golden.structure(lines, GRID)
    assert s["text"].tolist() == [0, 0, 0, 1, 0, 0, 3]  # "oh" is too short to count as a repeat


def test_terms_and_expand():
    terms = golden.terms()
    assert terms[: len(FE)] == [[f] for f in FE]
    assert ["tilde", "tilde"] not in terms and ["len_rank", "len_rank"] in terms and ["len_rank", "loud"] in terms
    X = np.arange(2 * len(FE), dtype=float).reshape(2, len(FE))
    T = golden.expand(X, [["sec"], ["sec", "log_sec"], ["loud", "loud"]])
    i, j, k = FE.index("sec"), FE.index("log_sec"), FE.index("loud")
    assert T[1].tolist() == [X[1, i], X[1, i] * X[1, j], X[1, k] ** 2]


def test_model_marks_by_the_table(tmp_path):
    lines, track = _song()
    path = _table(tmp_path, {"line_last": 6.0}, -5.0)  # line ends p=0.73, the rest 0.007: about 15 golden notes
    golden.mark(lines, GRID, track, 0.0, {"method": "model", "model": path})
    gold = [n for line in lines for n in line if n.type == "golden"]
    assert 12 <= len(gold) <= 16 and all(n.text == "end " for n in gold)
    golden.mark(lines, GRID, track, 0.0, {"method": "model", "model": path, "scale": 0.5})
    assert sum(n.type == "golden" for line in lines for n in line) < len(gold)


def test_model_table_needs_the_same_features(tmp_path):
    path = _table(tmp_path, {}, 0.0)
    table = json.loads(open(path).read())
    table["features"] = table["features"][:-1]
    (tmp_path / "old.json").write_text(json.dumps(table))
    with pytest.raises(ValueError, match="train it again"):
        golden.load_model(tmp_path / "old.json")


def test_fitted_table_matches_its_regression(tmp_path):
    """The saved table gives the probabilities of the regression it was fitted as (what the app's port relies on)."""
    from sklearn.linear_model import LogisticRegression

    lines, track = _song()
    X = golden.features(lines, GRID, track, 0.0)
    y = (X[:, FE.index("line_last")] == 1).astype(np.int8)
    y[::7] = 1 - y[::7]  # not separable
    model = golden_training._fit([{"X": X, "y": y}], linear=True)
    path = tmp_path / "m.json"
    path.write_text(json.dumps(model))
    p = golden.probabilities(golden.load_model(path), X)
    T = golden.expand(X, model["terms"])
    sd = T.std(axis=0)
    sd[sd == 0] = 1.0
    ref = LogisticRegression(C=1.0, max_iter=5000).fit((T - T.mean(axis=0)) / sd, y)
    assert p == pytest.approx(ref.predict_proba((T - T.mean(axis=0)) / sd)[:, 1], abs=1e-9)
    assert model["pick"] == golden.PICK


def _chart(lines: list[list[Note]]) -> Song:
    return Song(headers={"BPM": "300", "GAP": "0"}, voices=[lines])


def test_plausibility_of_identical_and_different_golden_notes():
    lines, _ = _song()
    ref = copy.deepcopy(lines)
    for line in ref:
        line[-1].type = "golden"  # every line's long last note
    rows, share, tenths = golden_training.style_rows(_chart(ref))
    assert rows.shape == (20, len(golden_training.STYLE)) and share == pytest.approx(20 / 140) and tenths == 10
    assert rows[:, 1].all() and rows[:, 3].all() and not rows[:, 4].any()  # last, longest, not in a run
    same = golden_training.plausibility_scores([(_chart(ref), _chart(copy.deepcopy(ref)))] * 5)
    assert same["last"] == (1.0, 1.0) and same["share_w1"] == 0 and same["c2st"] <= 0.6
    other = copy.deepcopy(lines)
    for line in other:
        line[0].type = "golden"  # every line's short first note
    d = golden_training.plausibility_scores([(_chart(ref), _chart(other))] * 5)
    assert d["last"] == (1.0, 0.0) and d["c2st"] > 0.9


def test_the_shipped_trees_are_the_default(tmp_path, monkeypatch):
    import pickle

    from tunestudio_training import recipes
    from tunestudio_training.pipeline import onnx_models

    lines, track = _song()
    X = golden.features(lines, GRID, track, 0.0)
    y = (X[:, FE.index("line_last")] == 1).astype(np.int8)
    path = tmp_path / "golden" / f"{recipes.SHIPPED['golden']}.pkl"
    path.parent.mkdir()
    path.write_bytes(pickle.dumps(golden_training._fit([{"X": X, "y": y}], linear=False)))
    monkeypatch.setattr(golden.paths, "models", lambda: tmp_path)
    monkeypatch.setattr(onnx_models, "folder", lambda: None)
    by_default = copy.deepcopy(lines)
    golden.mark(by_default, GRID, track, 0.0, {})
    golden.mark(lines, GRID, track, 0.0, {"method": "model", "model": str(path)})
    assert [n.type for line in by_default for n in line] == [n.type for line in lines for n in line]
    assert any(n.type == "golden" for line in lines for n in line)
    assert golden.shipped_model()["pick"] == golden.PICK
    assert golden.probabilities(golden.shipped_model(), X).dtype == np.float64
    monkeypatch.setattr(onnx_models, "folder", lambda: tmp_path)  # the export's golden.onnx, as the app runs it
    assert isinstance(golden.shipped_model()["trees"], onnx_models.Golden)
