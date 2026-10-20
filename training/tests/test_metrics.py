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
    assert all(v == 1.0 for v in s.row().values()), s.row()


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
