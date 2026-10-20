"""Splitting lyric words into sung syllables, the way UltraStar charters do.

Hyphenation (pyphen) is the wrong tool: it never leaves a single letter at a word edge ("a-way", "ü-bern")
and follows typesetting rules, not singing. Charters split per vowel sound. Learning the splits from existing
charts covers the common words; a vowel-group rule handles the rest.
"""

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

from tunestudio_training import paths

from .lyrics import Word, words_from_song
from .ultrastar import parse

VOWELS = {
    "english": "aeiouy",
    "german": "aeiouyäöü",
}
# Letter groups that are one vowel sound.
DIGRAPHS = {
    "english": [
        "eau",
        "ai",
        "au",
        "aw",
        "ay",
        "ea",
        "ee",
        "ei",
        "eu",
        "ew",
        "ey",
        "ie",
        "oa",
        "oe",
        "oi",
        "oo",
        "ou",
        "ow",
        "oy",
        "ue",
        "ui",
    ],
    "german": ["aa", "ai", "au", "äu", "ee", "ei", "eu", "ie", "oo", "ui"],
}
# Consonant groups that stay together and start the next syllable.
ONSETS = {
    "english": [
        "sch",
        "chr",
        "thr",
        "shr",
        "spr",
        "str",
        "scr",
        "ch",
        "sh",
        "th",
        "ph",
        "wh",
        "ck",
        "qu",
        "bl",
        "br",
        "cl",
        "cr",
        "dr",
        "fl",
        "fr",
        "gl",
        "gr",
        "pl",
        "pr",
        "sc",
        "sk",
        "sl",
        "sm",
        "sn",
        "sp",
        "st",
        "sw",
        "tr",
        "tw",
    ],
    "german": [
        "schr",
        "sch",
        "chr",
        "pf",
        "ch",
        "ck",
        "qu",
        "st",
        "sp",
        "bl",
        "br",
        "dr",
        "fl",
        "fr",
        "gl",
        "gr",
        "kl",
        "kr",
        "pl",
        "pr",
        "tr",
        "zw",
    ],
}
WORD = re.compile(r"[^\w']+")


def normalize(word: str) -> str:
    return WORD.sub("", word.lower().replace("’", "'"))


def _nuclei(word: str, language: str) -> list[tuple[int, int]]:
    """(start, end) of each vowel sound in the word."""
    vowels = VOWELS.get(language, VOWELS["english"])
    digraphs = sorted(DIGRAPHS.get(language, DIGRAPHS["english"]), key=len, reverse=True)
    out, i = [], 0
    while i < len(word):
        if word[i] in vowels and not (word[i] == "y" and i == 0):
            for d in digraphs:
                if word.startswith(d, i):
                    out.append((i, i + len(d)))
                    i += len(d)
                    break
            else:
                # "qu": the u belongs to the consonant.
                if word[i] == "u" and i > 0 and word[i - 1] == "q":
                    i += 1
                    continue
                out.append((i, i + 1))
                i += 1
        else:
            i += 1
    if language == "english" and len(out) > 1:
        # Silent final e ("make", "love"), but not "-le" ("little") or a word that is all vowels before it.
        s, e = out[-1]
        if word[s:e] == "e" and e == len(word) and not word.endswith("le"):
            out.pop()
        elif (
            word.endswith("es") and word[s:e] == "e" and e == len(word) - 1 and len(word) > 3 and word[-3] not in "scxz"
        ):
            out.pop()  # "makes", but keep "kisses"
        elif word.endswith("ed") and word[s:e] == "e" and e == len(word) - 1 and word[-3] not in "td":
            out.pop()  # "loved", but keep "wanted"
    return out


def rule_split(word: str, language: str) -> list[str]:
    """Split before the consonants leading into each vowel sound (one consonant or a known onset cluster)."""
    low = word.lower()
    nuclei = _nuclei(low, language)
    if len(nuclei) < 2:
        return [word]
    onsets = sorted(ONSETS.get(language, ONSETS["english"]), key=len, reverse=True)
    cuts = []
    for (_, prev_end), (start, _) in zip(nuclei, nuclei[1:]):
        cluster = low[prev_end:start]
        if not cluster:
            cut = start  # vowel directly after vowel: "cre-ate"
        elif any(cluster.endswith(o) and len(o) <= len(cluster) for o in onsets):
            o = next(o for o in onsets if cluster.endswith(o))
            cut = start - len(o)
        else:
            cut = start - 1  # one consonant starts the next syllable
        cuts.append(cut)
    parts, last = [], 0
    for c in cuts:
        if c > last:
            parts.append(word[last:c])
            last = c
    parts.append(word[last:])
    return [p for p in parts if p]


class Syllabifier:
    def __init__(self, language: str, table: dict[str, list[str]] | None = None):
        self.language = language.lower()
        self.table = table or {}

    def split(self, word: str) -> list[str]:
        """Split keeping the original casing/punctuation; the learned split applies to the letters."""
        key = normalize(word)
        pattern = self.table.get(key)
        if pattern is None:
            return rule_split(word, self.language)
        # Map the learned split (on normalized letters) back onto the original word.
        out, pos, letters = [], 0, 0
        bounds = [sum(len(p) for p in pattern[: i + 1]) for i in range(len(pattern) - 1)]
        for i, ch in enumerate(word):
            if normalize(ch):
                if letters in bounds and i > pos:
                    out.append(word[pos:i])
                    pos = i
                letters += 1
        out.append(word[pos:])
        return out


def chart_split(word: Word) -> list[str] | None:
    """A charted word's sung syllables (normalized). Notes like "~ng" in "so~ng" continue the previous
    syllable (the charter wrote out the held sound), so they are merged back."""
    parts: list[str] = []
    for syl in word.syllables:
        text = normalize(syl.text)
        if syl.text.startswith("~") and parts:
            parts[-1] += text
        elif text:
            parts.append(text)
    return parts if parts and "".join(parts) else None


def learn(charts: list[Path], language: str, min_count: int = 1) -> dict[str, list[str]]:
    """Most common split per word in hand-made charts of one language."""
    counts: dict[str, Counter] = defaultdict(Counter)
    for path in charts:
        try:
            song = parse(path)
        except Exception:  # noqa: BLE001
            continue
        if song.headers.get("LANGUAGE", "").split(",")[0].strip().lower() != language:
            continue
        for w in words_from_song(song):
            parts = chart_split(w)
            if parts:
                counts["".join(parts)][tuple(parts)] += 1
    return {w: list(c.most_common(1)[0][0]) for w, c in counts.items() if c.most_common(1)[0][1] >= min_count}


def table_path(language: str) -> Path:
    """The learned table Tune Studio ships (`tst syllables` rebuilds it from the train split)."""
    return paths.CHARTING / "data" / f"syllables-{language}.json"


def save(table: dict[str, list[str]], path: Path) -> None:
    path.write_text(json.dumps(table, ensure_ascii=False, sort_keys=True))


def load(path: Path) -> dict[str, list[str]]:
    return json.loads(path.read_text()) if path.exists() else {}
