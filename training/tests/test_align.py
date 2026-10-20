import numpy as np
import pytest

from tunestudio_training.pipeline import align
from tunestudio_training.pipeline.align import WordTiming


def test_parts_and_words():
    assert align._parts("oh–oh—oh") == ["oh", "oh", "oh"]
    assert align._parts("so~ng") == ["song"]
    assert align._parts("well-known") == ["well", "known"]
    assert align._parts("--") == []
    assert align.is_word("a") and align.is_word("über") and not align.is_word("...") and not align.is_word("~")


def test_time_at():
    w = WordTiming("abcd", 1.0, 2.0, 0.0, [(1.0, 1.1), (1.2, 1.3), (1.5, 1.6), (1.8, 1.9)])
    assert w.time_at(0.5) == 1.5
    assert WordTiming("x", 1.0, 2.0, 0.0, []).time_at(0.25) == 1.25


def test_pull_in_edges():
    words = [
        WordTiming("I", 0.0, 0.2, 0, [(0.0, 0.1)]),
        WordTiming("am", 3.0, 3.4, 0, []),
        WordTiming("here", 3.5, 3.9, 0, []),
        WordTiming("ooh", 9.0, 15.0, 0, [(9.0, 9.1)]),
    ]
    align.pull_in_edges(words)
    assert (words[0].start, words[0].end, words[0].chars) == (pytest.approx(2.7), 3.0, [])
    assert (words[-1].start, words[-1].end, words[-1].chars) == (3.9, pytest.approx(5.9), [])
    one = [WordTiming("x", 0.0, 1.0, 0, [])]
    align.pull_in_edges(one)
    assert one[0].start == 0.0


def test_snap_to_voice_moves_starts_to_loud_singing():
    hop = 0.01
    midi = np.full(300, np.nan)
    midi[120:250] = 60.0
    rms = np.where(np.isnan(midi), -60.0, -10.0)
    words = [WordTiming("a", 1.0, 2.0, 0, []), WordTiming("b", 2.0, 2.4, 0, [])]
    align.snap_to_voice(words, midi, rms, hop)
    assert words[0].start == pytest.approx(1.2)
    assert words[1].start == 2.0  # already sung at its start
