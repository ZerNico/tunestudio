"""Turning UltraStar notes into words/syllables and plain lyrics into syllables."""

from dataclasses import dataclass
from functools import cache

from .ultrastar import Note, Song


@dataclass
class Syllable:
    text: str
    notes: list[Note]  # first note carries the text, the rest are "~" continuations


@dataclass
class Word:
    syllables: list[Syllable]
    line: int

    @property
    def text(self) -> str:
        return "".join(s.text for s in self.syllables)


def _is_continuation(text: str) -> bool:
    return text.strip() in ("~", "")


def words_from_song(song: Song, voice: int = 0) -> list[Word]:
    """Group a chart's notes back into words made of syllables (the inverse of what charting produces)."""
    words: list[Word] = []
    for line_no, phrase in enumerate(song.voices[voice]):
        current: Word | None = None
        for note in phrase:
            if _is_continuation(note.text) and current and current.syllables:
                current.syllables[-1].notes.append(note)
                if note.text.endswith(" "):
                    current = None
                continue
            starts_word = note.text.startswith(" ") or current is None
            if starts_word:
                current = Word([], line_no)
                words.append(current)
            current.syllables.append(Syllable(note.text.strip(), [note]))
            if note.text.endswith(" "):
                current = None
    return [w for w in words if w.syllables]


@cache
def _syllabifier(language: str):
    from . import syllables

    lang = language.lower()
    table = syllables.load(syllables.table_path(lang))
    return syllables.Syllabifier(lang, table)


def syllabify(word: str, language: str) -> list[str]:
    """Sung syllables: learned from hand-made charts where known, vowel-group rules otherwise (see syllables.py)."""
    return _syllabifier(language).split(word)
