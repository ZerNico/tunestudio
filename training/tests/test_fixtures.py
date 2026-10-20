import importlib.metadata
import json

import pytest

from tunestudio_training import fixtures, paths


def test_numpy_reference_matches_the_committed_fixture():
    committed = (paths.CHARTING / "fixtures" / "numpy.json").read_text()
    assert json.dumps(fixtures.numpy_reference()) + "\n" == committed


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
