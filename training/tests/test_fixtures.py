import importlib.metadata
import json
import math
import platform
import sys

import pytest

from tunestudio_training import fixtures, paths


def _close(a, b) -> bool:
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_close(a[k], b[k]) for k in a)
    if isinstance(a, (list, tuple)):
        return len(a) == len(b) and all(_close(x, y) for x, y in zip(a, b))
    return math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)


def test_numpy_reference_matches_the_committed_fixture():
    """Byte for byte on Apple Silicon, where the fixture is made. NumPy's SIMD sums and exp differ in the last bits on
    other CPUs (CI runs on x86 Linux), so there it only has to agree to 1e-12."""
    committed = (paths.CHARTING / "fixtures" / "numpy.json").read_text()
    made = json.dumps(fixtures.numpy_reference()) + "\n"
    if sys.platform == "darwin" and platform.machine() == "arm64":
        assert made == committed
    else:
        assert _close(json.loads(made), json.loads(committed))


def test_aligner_text_cases_reproduce():
    from ctc_forced_aligner.text_utils import preprocess_text

    cases = json.loads((paths.CHARTING / "fixtures" / "aligner-text.json").read_text())
    wrong = []
    for text, lang, want in cases[::10]:
        tokens, _ = preprocess_text(text, romanize=True, language=lang, split_size="word")
        if [t for t in tokens if t != "<star>"] != want:
            wrong.append(text)
    assert not wrong[:5]


def test_table_names_the_uroman_it_was_made_with():
    table = json.loads((paths.CHARTING / "data" / "aligner-text.json").read_text())
    assert table["uroman"] == importlib.metadata.version("uroman")


def test_syllable_words_skip_lines(monkeypatch):
    found = {"english": {"hello", "two words", "", "yes"}, "german": {"ja"}}
    words = fixtures.syllable_words(found, 10)
    assert sorted(words) == [("hello", "english"), ("ja", "german"), ("yes", "english")]


@pytest.mark.parametrize("char_class, expected", [("a-c", "abc"), ("\\d", None)])
def test_members(char_class, expected):
    got = fixtures._members(char_class)
    if expected:
        assert got == expected
    else:
        assert "0" in got and "٣" in got
