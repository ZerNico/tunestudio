import numpy as np
import pytest

from tunestudio_training.pipeline import beats, boundary, chart, ends, notefix
from tunestudio_training.pipeline.align import WordTiming
from tunestudio_training.pipeline.game import GameNote
from tunestudio_training.pipeline.pitch import PitchTrack
from tunestudio_training.pipeline.ultrastar import Note


def test_grid():
    g = chart.Grid(bpm=480, gap=2.0)
    assert g.unit == pytest.approx(60 / (480 * 4))
    assert g.to_beat(2.0 + 10 * g.unit) == 10
    assert g.to_sec(10) == pytest.approx(2.0 + 10 * g.unit)


def test_make_grid_puts_beat_zero_on_the_beat_before_the_first_note():
    g = chart.make_grid(120, 0.1, 2.3)
    assert g.bpm == 480 and g.gap == pytest.approx(2.1)


def test_syllable_spans():
    w1 = WordTiming("hello", 1.0, 1.5, -0.5, [(1.0 + 0.1 * i, 1.1 + 0.1 * i) for i in range(5)])
    w2 = WordTiming("you", 2.0, 2.3, -0.2, [])
    spans = chart.syllable_spans([w1, w2], [["hel", "lo"], ["you"]], None, max_tail=1.5)
    assert [s.text for s in spans] == ["hel", "lo ", "you "]
    assert [s.start for s in spans] == pytest.approx([1.0, 1.3, 2.0])
    assert [s.end for s in spans] == pytest.approx([1.3, 2.0, 3.8])  # the last: word end + max_tail
    spans = chart.syllable_spans([w1], [["hel", "lo"]], 1.6)
    assert spans[-1].end == pytest.approx(1.6)


def test_build_song_merges_overlaps_and_lengthens():
    g = chart.Grid(bpm=300, gap=0.5)  # unit 0.05 s: notes under 2 units (0.1 s) get lengthened
    lines = [
        [Note("normal", 0, 4, 2, "Hel"), Note("normal", 4, 3, 2, "~"), Note("normal", 8, 1, 4, "lo ")],
        [Note("normal", 8, 4, 5, "a "), Note("normal", 20, 1, 5, "b ")],
    ]
    song = chart.build_song(lines, g, {"TITLE": "x"})
    assert song.headers["BPM"] == "300" and song.headers["GAP"] == "500"
    notes = song.notes()
    # "~" on the same pitch right after its note joins it.
    assert (notes[0].start, notes[0].length, notes[0].text) == (0, 7, "Hel")
    # Starts strictly increase and notes don't overlap.
    assert all(a.start < b.start and a.start + a.length <= b.start for a, b in zip(notes, notes[1:]))
    assert notes[-1].length == 2
    assert song.breaks == {(0, 1): 9}


def test_split_lines_at_long_pauses():
    g = chart.Grid(bpm=300, gap=0)
    line = [Note("normal", i * 4, 3, 0, w) for i, w in enumerate(["one ", "two ", "three "])]
    line += [Note("normal", 40 + i * 4, 3, 0, w) for i, w in enumerate(["four ", "five ", "six "])]
    assert [len(x) for x in chart.split_lines([line], g)] == [3, 3]
    assert chart.split_lines([line[:3]], g) == [line[:3]]


def test_line_breaks_leave_time_to_read():
    g = chart.Grid(bpm=300, gap=0)  # 0.05 s per beat
    lines = [[Note("normal", 0, 10, 0, "a ")], [Note("normal", 70, 4, 0, "b ")]]
    # pause 60 beats = 3 s: break 40% in (1.2 s = 24 beats) after the end
    assert chart.line_breaks(lines, g) == {(0, 1): 34}


def test_scale_and_tuning():
    midi = np.array([60, 62, 64, 65, 67, 69, 71] * 20, float) + 0.2
    track = PitchTrack(np.arange(len(midi)) * 0.01, midi)
    assert chart.tuning_offset(track) == pytest.approx(0.2)
    assert chart.estimate_scale(track, 0.2) == frozenset({0, 2, 4, 5, 7, 9, 11})


class FakeGame:
    """GAME's interface with fixed notes: two per call, the second a fifth up."""

    sr = 16000

    def __init__(self):
        self.calls = []

    def extract(self, waveform, known=None, language=0, boundary_threshold=0.2, presence_threshold=0.2):
        self.calls.append(known)
        d = len(waveform) / self.sr
        return [GameNote(0.0, d / 2, True, 60.2), GameNote(d / 2, d, True, 67.0)]


def test_notes_for_line_game():
    g = chart.Grid(bpm=300, gap=0.0)
    spans = [chart.SyllableSpan("la ", 1.0, 2.0, -0.1)]
    game = FakeGame()
    trace = []
    notes = chart.notes_for_line_game(spans, np.zeros(16000 * 4, np.float32), game, g, trace=trace)
    # From 0.2 s before the span to 0.2 s after, the syllable start a known boundary.
    assert game.calls == [pytest.approx([0.2, 1.2])]
    assert [(n.text, n.pitch) for n in notes] == [("la", 0), ("~ ", 7)]
    assert [t["part"] for t in trace] == [0, 1] and trace[0]["raw"] == pytest.approx(60.2)


def test_boundary_assign_is_one_to_one_and_keeps_order():
    probs = np.zeros(200)
    probs[50] = 0.9  # 1.0 s
    probs[60] = 0.6  # 1.2 s
    out = boundary.assign([0.95, 1.05], probs, radius=0.2, min_prob=0.3, cost=0.5)
    assert out == pytest.approx([1.0, 1.2])
    assert boundary.assign([], probs) == []
    assert boundary.assign([3.0], probs) == [3.0]  # no peak near: stays


def test_refiner_features_have_the_shipped_widths():
    track = PitchTrack(np.arange(300) * 0.01, np.full(300, 60.3))
    notes = [Note("normal", 0, 4, 0, "a"), Note("normal", 4, 4, 2, "b ")]
    trace = [
        {"start": 0.1, "end": 1.0, "raw": 60.4, "part": 0, "parts": 1},
        {"start": 1.0, "end": 2.0, "raw": 62.1, "part": 0, "parts": 1},
    ]
    feats = notefix.features(notes, trace, track, 0.3, frozenset({0, 2, 4, 5, 7, 9, 11}))
    assert len(feats) == 2 and all(len(f) == len(notefix.FEATURES) == 24 for f in feats)
    X = ends.features(feats, [0.1, 1.0], [1.0, 2.0])
    assert X.shape == (2, len(ends.FEATURES)) == (2, 27)


def test_fit_grid_recovers_the_tempo():
    t = 0.37 + np.arange(200) * 0.5  # 120 BPM
    bpm, t0, residual = beats.Beats(t, t[::4]).fit_grid()
    assert bpm == pytest.approx(120, abs=0.01) and residual < 0.01
    assert (t0 - 0.37) / 0.25 == pytest.approx(round((t0 - 0.37) / 0.25), abs=0.05)
