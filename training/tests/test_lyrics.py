from tunestudio_training.pipeline import lyrics, ultrastar

from conftest import write_chart


def test_words_from_song(tmp_path):
    notes = [
        [
            (":", 0, 2, 0, "Hel"),
            (":", 2, 2, 0, "lo "),
            (":", 4, 2, 0, "~"),
            (":", 6, 2, 0, " so"),
            (":", 8, 2, 0, "~ng "),
        ],
        [(":", 20, 2, 0, "a"), (":", 22, 2, 0, "~ "), (":", 24, 2, 0, "b")],
    ]
    song = ultrastar.parse(write_chart(tmp_path / "S", notes))
    words = lyrics.words_from_song(song)
    # A "~" after a finished word starts a word of its own, and "~ng" is a syllable of the word it's in.
    assert [(w.text, w.line) for w in words] == [("Hello", 0), ("~", 0), ("so~ng", 0), ("a", 1), ("b", 1)]
    assert [s.text for s in words[0].syllables] == ["Hel", "lo"]
    # A "~ " note joins the syllable before and ends the word.
    assert len(words[3].syllables[0].notes) == 2


def test_syllabify_uses_the_committed_tables():
    assert lyrics.syllabify("together", "english") == ["to", "ge", "ther"]
    assert "".join(lyrics.syllabify("Wunderbar,", "german")) == "Wunderbar,"
