import json

import pytest

from tunestudio_training import paths
from tunestudio_training.pipeline import lyrics, syllables, ultrastar

from conftest import write_chart


# Today's rules, quirks included ("aw-ay", "que-en": "aw" and "ue" read as one vowel sound): the learned tables
# cover common words, so these only decide rare ones. A change here changes charts.
@pytest.mark.parametrize(
    "word, language, parts",
    [
        ("away", "english", ["aw", "ay"]),
        ("make", "english", ["make"]),
        ("little", "english", ["litt", "le"]),
        ("makes", "english", ["makes"]),
        ("kisses", "english", ["kis", "ses"]),
        ("loved", "english", ["loved"]),
        ("wanted", "english", ["wan", "ted"]),
        ("queen", "english", ["que", "en"]),
        ("yellow", "english", ["yel", "low"]),
        ("together", "english", ["to", "ge", "ther"]),
        ("stronger", "english", ["stron", "ger"]),
        ("Sonne", "german", ["Son", "ne"]),
        ("Fenster", "german", ["Fen", "ster"]),
        ("übern", "german", ["ü", "bern"]),
        ("Schmetterling", "german", ["Schmet", "ter", "ling"]),
        ("a", "english", ["a"]),
    ],
)
def test_rule_split(word, language, parts):
    assert syllables.rule_split(word, language) == parts


def test_syllabifier_keeps_casing_and_punctuation():
    s = syllables.Syllabifier("english", {"don't": ["do", "n't"], "hello": ["hel", "lo"]})
    assert s.split("Hello,") == ["Hel", "lo,"]
    assert s.split("Don’t!") == ["Do", "n’t!"]
    assert s.split("never") == syllables.rule_split("never", "english")


def test_learn_picks_the_most_common_split(tmp_path):
    def chart(name, parts, language="English"):
        notes = [[(":", i * 2, 2, 0, p + (" " if i == len(parts) - 1 else "")) for i, p in enumerate(parts)]]
        return write_chart(tmp_path / name, notes, language=language)

    charts = [chart("a", ["ba", "na", "na"]), chart("b", ["ba", "na", "na"]), chart("c", ["ban", "a", "na"])]
    charts.append(chart("d", ["ba", "nana"], language="German"))
    assert syllables.learn(charts, "english") == {"banana": ["ba", "na", "na"]}


def test_chart_split_merges_written_out_held_sounds(tmp_path):
    notes = [[(":", 0, 2, 0, "so"), (":", 2, 2, 0, "~ng "), (":", 4, 2, 0, "Hel"), (":", 6, 2, 0, "lo! ")]]
    words = lyrics.words_from_song(ultrastar.parse(write_chart(tmp_path / "S", notes)))
    assert [syllables.chart_split(w) for w in words] == [["song"], ["hel", "lo"]]


def test_committed_fixture_rows_reproduce():
    """Every row of the app's syllables fixture splits the same through the pipeline (the committed tables)."""
    rows = json.loads((paths.CHARTING / "fixtures" / "syllables.json").read_text())
    assert len(rows) > 1000
    wrong = [(w, lang, want) for w, lang, want in rows if lyrics.syllabify(w, lang) != want]
    assert not wrong[:10]
