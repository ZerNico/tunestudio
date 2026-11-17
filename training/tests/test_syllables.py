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
        ("corazón", "spanish", ["co", "ra", "zón"]),
        ("silencio", "spanish", ["si", "len", "cio"]),
        ("ayer", "spanish", ["a", "yer"]),
        ("minha", "Portuguese (Brazil)", ["mi", "nha"]),
        ("dia", "portuguese", ["di", "a"]),
        ("memória", "portuguese", ["me", "mó", "ria"]),
        ("danse", "french", ["danse"]),
        ("allez", "french", ["a", "llez"]),
        ("niin", "finnish", ["niin"]),
        ("jibun", "japanese", ["ji", "bu", "n"]),
        ("neomu", "korean", ["neo", "mu"]),
        ("我爱你", "chinese", ["我", "爱", "你"]),
        ("「ちょっと」", "japanese", ["「ちょっ", "と」"]),
        ("любовь", "russian", ["лю", "бовь"]),
        ("αγάπη", "greek", ["α", "γά", "πη"]),
        # A language without rules of its own: each vowel of any Latin, Cyrillic or Greek letter is a syllable.
        ("kaikki", "klingon", ["ka", "ik", "ki"]),
    ],
)
def test_rule_split(word, language, parts):
    assert syllables.rule_split(word, language) == parts


def test_romanized_kpop_borrows_english_splits():
    # The English table the app ships (only what its patterns miss) splits "actually" like charters.
    assert lyrics.syllabify("actually", "Korean (romanized)") == lyrics.syllabify("actually", "English")
    assert lyrics.syllabify("actually", "Korean (romanized)") != syllables.rule_split("actually", "korean")


def test_committed_rules_are_the_rules():
    committed = json.loads((paths.CHARTING / "data" / "syllable-rules.json").read_text())
    assert committed == json.loads(json.dumps(syllables.rules_data()))


def test_committed_tables_hold_only_the_words_the_rest_splits_otherwise():
    committed = json.loads(syllables.patterns_path().read_text())
    for language, patterns in committed.items():
        loanwords = syllables.rules_for(language).loanwords
        borrowed = syllables.load(syllables.table_path(loanwords)) if loanwords else {}
        table = syllables.load(syllables.table_path(language))
        assert table and syllables.prune(table, language, patterns, borrowed) == table, language


def test_pruning_keeps_every_split():
    table = {w: [w[: w.index("ss")], w[w.index("ss") :]] for w in ("assa", "esse", "isso", "osso", "ussa", "assi")}
    table["missa"] = ["mis", "sa"]  # the exception the patterns don't learn
    patterns = syllables.learn_patterns(table, "portuguese")
    pruned = syllables.prune(table, "portuguese", patterns, {})
    assert pruned == {"missa": ["mis", "sa"]}
    whole, shipped = syllables.Syllabifier("pt", table, patterns), syllables.Syllabifier("pt", pruned, patterns)
    assert all(whole.split(w) == shipped.split(w) for w in table)


def test_patterns_correct_the_rules():
    # A table that splits every "ss" word before the ss: the rules cut "pas-sa", the patterns learn "pa-ssa".
    table = {w: [w[: w.index("ss")], w[w.index("ss") :]] for w in ("assa", "esse", "isso", "osso", "ussa", "assi")}
    patterns = syllables.learn_patterns(table, "portuguese")
    assert syllables.rule_split("passa", "portuguese") == ["pas", "sa"]
    assert syllables.pattern_split("passa", "portuguese", patterns) == ["pa", "ssa"]
    # A part without a vowel joins its neighbour.
    assert syllables.pattern_split("rhythm", "english", {".rh1": [0, 0, 0, 1]}) == ["rhythm"]


def test_unknown_words_are_split_by_the_corrected_rules():
    assert lyrics.syllabify("Reißverschlussverkauf", "German") == ["Reiß", "ver", "schluss", "ver", "kauf"]
    assert lyrics.syllabify("inconditionnel", "French") == ["in", "con", "di", "tion", "nel"]
    # Languages without a table have no patterns: the rules alone.
    assert lyrics.syllabify("gezellig", "Dutch") == syllables.rule_split("gezellig", "dutch")


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
