import numpy as np
import pytest

from tunestudio_training import metrics
from tunestudio_training.pipeline import ultrastar
from tunestudio_training.pipeline.pitch import PitchTrack

from conftest import write_chart

# Notes of varied pitch and length, so a pitch track made from them has one clear best offset.
MELODY = [[(":", i * 6, 4, [0, 4, 7, 2, 9, 5, 11, 3][i % 8], f"la{i} ") for i in range(40)]]


def _song(tmp_path, notes=MELODY, **kw) -> ultrastar.Song:
    return ultrastar.parse(write_chart(tmp_path / "S", notes, **kw))


def test_identical_charts_score_one(tmp_path):
    song = _song(tmp_path)
    s = metrics.compare(song, song)
    # without golden notes in the chart there are none to judge
    golden = {k: v for k, v in s.row().items() if k.startswith("golden_")}
    assert golden and all(np.isnan(v) for v in golden.values())
    assert all(v == 1.0 for k, v in s.row().items() if k not in golden), s.row()
    gilded = _song(tmp_path, _gild(MELODY, {0, 8, 16}))
    assert all(v == 1.0 for v in metrics.compare(gilded, gilded).row().values())


def _gild(notes, golden: set[int], shift: int = 0, length: int | None = None):
    """MELODY with the notes at these indexes golden (moved by `shift` beats, `length` beats long)."""
    return [
        [
            ("*", s + shift, length or n, p, x) if i in golden else (t, s, n, p, x)
            for i, (t, s, n, p, x) in enumerate(line)
        ]
        for line in notes
    ]


def test_golden_precision_recall(tmp_path):
    ref = _song(tmp_path, _gild(MELODY, {0, 8, 16}))
    gen = _song(tmp_path, _gild(MELODY, {0, 8, 24, 32}))
    s = metrics.golden_scores(ref, gen)
    assert s["golden_precision"] == 0.5 and s["golden_recall"] == pytest.approx(2 / 3)
    assert s["golden_f1"] == pytest.approx(4 / 7) and s["golden_count_ratio"] == pytest.approx(4 / 3)
    # pitch doesn't matter: the golden marking is judged, note_f1 judges the pitch
    off = [[(t, s, n, p + 1, x) for t, s, n, p, x in line] for line in _gild(MELODY, {0, 8, 16})]
    assert metrics.golden_scores(ref, _song(tmp_path, off))["golden_f1"] == 1.0


def test_golden_matches_by_onset_or_overlap(tmp_path):
    # BPM 300: a beat is 50 ms. A held reference note (0.4 s) that our golden note starts 150 ms after still
    # matches (overlap 0.25 s of the shorter 0.4 s); a short one 150 ms off doesn't (no overlap, onset too far).
    ref = _song(tmp_path, _gild(MELODY, {0}, length=8) + [[("*", 300, 2, 0, "x ")]])
    gen = _song(tmp_path, _gild(MELODY, {0}, shift=3, length=8) + [[("*", 303, 2, 0, "x ")]])
    s = metrics.golden_scores(ref, gen)
    assert s["golden_precision"] == 0.5 and s["golden_recall"] == 0.5
    # within ONSET_TOL counts as a match even without overlap
    near = _song(tmp_path, _gild(MELODY, {0}, length=8) + [[("*", 301, 1, 0, "x ")]])
    assert metrics.golden_scores(ref, near)["golden_f1"] == 1.0


def test_golden_matching_is_one_to_one(tmp_path):
    # one held reference golden note, our two golden notes inside it: one hit
    ref = _song(tmp_path, [[("*", 0, 20, 0, "la ")], [(":", 100, 4, 0, "x ")]])
    gen = _song(tmp_path, [[("*", 0, 10, 0, "la"), ("*", 10, 10, 0, "~ ")], [(":", 100, 4, 0, "x ")]])
    s = metrics.golden_scores(ref, gen)
    assert s["golden_recall"] == 1.0 and s["golden_precision"] == 0.5


def test_golden_without_golden_notes(tmp_path):
    plain, gilded = _song(tmp_path), _song(tmp_path, _gild(MELODY, {0, 8}))
    assert all(np.isnan(v) for v in metrics.golden_scores(plain, gilded).values())
    none = metrics.golden_scores(gilded, plain)
    assert none["golden_f1"] == 0 and none["golden_recall"] == 0 and none["golden_count_ratio"] == 0
    assert np.isnan(none["golden_precision"])


def test_onset_tolerance(tmp_path):
    song = _song(tmp_path)
    assert metrics.compare(song, metrics.shifted(song, 0.09)).note_f1 == 1.0
    assert metrics.compare(song, metrics.shifted(song, 0.11)).onset_f1 == 0.0


def test_pitch_is_octave_agnostic(tmp_path):
    ref = _song(tmp_path)
    up = [[(t, s, n, p + 12, x) for t, s, n, p, x in line] for line in MELODY]
    off = [[(t, s, n, p + 1, x) for t, s, n, p, x in line] for line in MELODY]
    assert metrics.compare(ref, _song(tmp_path, up)).note_f1 == 1.0
    worse = metrics.compare(ref, _song(tmp_path, off))
    assert worse.note_f1 == 0.0 and worse.onset_f1 == 1.0 and worse.pitch_within1 == 1.0


def test_frame_f1_penalises_notes_that_run_on(tmp_path):
    ref = _song(tmp_path)
    longer = [[(t, s, n + 2, p, x) for t, s, n, p, x in line] for line in MELODY]
    s = metrics.compare(ref, _song(tmp_path, longer))
    assert s.combined == 1.0 and s.recall == 1.0
    assert s.frame_f1 < 0.9 and s.precision < 0.7


@pytest.mark.parametrize("bpm, ratio", [(300, 1.0), (600, 1.0), (150, 1.0), (360, 1.2), (75, 1.0)])
def test_tempo_ratio_folds_double_and_half_time(tmp_path, bpm, ratio):
    ref = _song(tmp_path)
    gen = _song(tmp_path, bpm=bpm)
    assert metrics.compare(ref, gen).tempo_ratio == pytest.approx(ratio)


def test_reference_offset_finds_a_shift(tmp_path):
    # Notes without gaps, neighbours 2+ semitones apart: only the true shift lines every frame up.
    legato = [[(t, s, 6, p, x) for t, s, _, p, x in line] for line in MELODY]
    ref = _song(tmp_path, legato)
    sung = metrics.shifted(ref, 0.2)  # the singer is 0.2 s later than the chart
    n = 3000
    track = PitchTrack(np.arange(n) * metrics.HOP, metrics._frames(sung, n))
    offset = metrics.reference_offset(ref, track)
    assert offset == pytest.approx(0.2 - metrics.SCOOP_BIAS, abs=metrics.HOP)


def test_shifted_moves_the_gap_only(tmp_path):
    ref = _song(tmp_path)
    out = metrics.shifted(ref, -0.5)
    assert out.gap == ref.gap - 500 and out.voices is ref.voices and ref.gap == 1000
