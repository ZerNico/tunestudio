"""The generated files the app's charting code commits (apps/studio/electron/charting/): tables it charts with (data/)
and fixtures its tests compare against exactly (fixtures/). Words, never song lyrics.

- data/aligner-text.json: what ctc-forced-aligner's `preprocess_text(..., romanize=True)` does to lyrics before
  alignment, as data: the normalization sets and mappings of norm_config["*"], and uroman's output per character
  (filtered the way `normalize_uroman` filters it: lowercase, only a-z and ') for every NFKC-stable character of the
  Latin, Hangul and CJK ranges plus symbols, as `base` (language "eng") and per-language differences. These scripts
  romanize character by character (checked here: every pair of their characters gives the same tokens as uroman);
  Cyrillic, Greek and kana have context rules and aren't covered yet.
- data/syllables-<language>.json: the learned syllable splits (`syllable_tables`, from the train split only).
- fixtures/aligner-text.json: [text, language, tokens] for lines of real lyric words (shuffled, no song's lyrics) and
  random strings, with the expected `preprocess_text` tokens (without the <star> tokens).
- fixtures/syllables.json: [word, language, syllables] for words as charted (casing, punctuation, apostrophes),
  English and German, plus French ones for the rule fallback of other languages.
- fixtures/numpy.json: NumPy's results (pairwise sums, means, std, median, percentiles, complex means, arange,
  Python's round and %) on seeded random data, float64 and float32, for the app's numpy.ts.

Both word samples come from every chart of the library (TST_LIBRARY), so they only reproduce on the same library.
"""

import importlib.metadata
import itertools
import json
import random
import re
import unicodedata
from pathlib import Path

import numpy as np

from tunestudio_training import library, splits
from tunestudio_training.pipeline import lyrics, syllables, ultrastar

LANGUAGES = ["eng", "deu", "fra", "spa", "ita", "nld", "por", "pol", "swe", "fin", "tur", "kor", "cmn"]
RANGES = [
    (0x20, 0x24F),  # Basic Latin to Latin Extended-B
    (0x250, 0x2FF),  # IPA, modifier letters
    (0x1E00, 0x1EFF),  # Latin Extended Additional
    (0x2000, 0x2BFF),  # punctuation, symbols, arrows, ...
    (0x3000, 0x303F),  # CJK punctuation
    (0x3131, 0x318E),  # Hangul compatibility jamo
    (0x4E00, 0x9FFF),  # CJK unified ideographs
    (0xAC00, 0xD7A3),  # Hangul syllables
]
SYLLABLE_LANGUAGES = ("english", "german", "french")
TABLE_LANGUAGES = ("english", "german")


def _chart_words() -> dict[str, set[str]]:
    """Every charted word per chart language (first language of #LANGUAGE, lowercase)."""
    found: dict[str, set[str]] = {}
    for folder in library.folders():
        for txt in folder.glob("*.txt"):
            try:
                song = ultrastar.parse(txt)
            except Exception:  # noqa: BLE001
                continue
            lang = song.headers.get("LANGUAGE", "").split(",")[0].strip().lower()
            found.setdefault(lang, set()).update(w.text.strip().replace("~", "") for w in lyrics.words_from_song(song))
    return found


def syllable_words(found: dict[str, set[str]], per_language: int) -> list[tuple[str, str]]:
    rng = random.Random(0)
    out = []
    for lang in SYLLABLE_LANGUAGES:
        ordered = sorted(w for w in found.get(lang, set()) if w)
        sample = rng.sample(ordered, min(per_language, len(ordered)))
        # Single words only: a "word" with spaces is a chart line kept whole, i.e. a piece of lyrics.
        out += [(w, lang) for w in sample if not any(c.isspace() for c in w)]
    return out


def numpy_reference() -> dict:
    rng = np.random.default_rng(1)
    cases = {}
    for n in [1, 5, 7, 8, 9, 16, 127, 128, 129, 300, 1000, 4097]:
        x = rng.standard_normal(n) * 1e3 + rng.standard_normal(n)
        z = np.exp(2j * np.pi * x / 0.3)
        m = z.mean()
        cases[str(n)] = {
            "x": x.tolist(), "sum": float(np.sum(x)), "mean": float(np.mean(x)), "std": float(np.std(x)),
            "median": float(np.median(x)), **{f"p{q}": float(np.percentile(x, q)) for q in (10, 25, 75, 90)},
            "cmean": [float(m.real), float(m.imag)], "zr": z.real.tolist(), "zi": z.imag.tolist(),
        }  # fmt: skip
    cases32 = {}
    for n in [1, 2, 5, 8, 9, 100, 129, 1001, 5000]:
        x = (rng.standard_normal(n) * 10 - 30).astype(np.float32)
        cases32[str(n)] = {
            "x": x.tolist(), "sum": float(np.sum(x)), "mean": float(np.mean(x)), "std": float(np.std(x)),
            "median": float(np.median(x)), **{f"p{q}": float(np.percentile(x, q)) for q in (10, 25, 75, 90)},
        }  # fmt: skip
    return {
        "cases": cases,
        "cases32": cases32,
        "arange": {"a": np.arange(80, 160, 0.05).tolist(), "b": np.arange(105.05 - 0.1, 105.05 + 0.1, 0.001).tolist()},
        "rounds": [(x, round(x)) for x in [0.5, 1.5, 2.5, -0.5, -1.5, 2.4999999, 2.5000001, -2.5]],
        "mods": [
            (a, b, a % b) for a, b in [(-1e-17, 12), (-13, 12), (13, -12), (5.5, 12), (-0.0, 12), (-6.000000001, 12)]
        ],
    }


class _Romanizer:
    def __init__(self):
        from uroman import Uroman

        self.uroman = Uroman()

    def __call__(self, text: str, lcode: str) -> str:
        """uroman's output as normalize_uroman leaves it, without the spaces between characters."""
        from ctc_forced_aligner.text_utils import normalize_uroman

        return normalize_uroman(" ".join(self.uroman.romanize_string(text, lcode=lcode).strip())).replace(" ", "")


def _characters() -> list[str]:
    out = []
    for lo, hi in RANGES:
        for c in map(chr, range(lo, hi + 1)):
            if unicodedata.category(c).startswith("C") or unicodedata.normalize("NFKC", c) != c:
                continue
            if c.lower() != c:  # text is lowercased before romanization
                continue
            out.append(c)
    return out


def _tables(rom: _Romanizer, chars: list[str]) -> dict:
    base = {c: rom(c, "eng") for c in chars}
    by_language = {}
    for lang in LANGUAGES[1:]:
        diff = {c: r for c in chars if (r := rom(c, lang)) != base[c]}
        if diff:
            by_language[lang] = diff
    return {"base": {c: r for c, r in base.items() if r}, "languages": by_language}


def _check_pairs(rom: _Romanizer, chars: list[str], table: dict) -> None:
    """Every pair of letters of each script romanizes as its two characters (no context rules)."""
    groups = {
        "latin": [c for c in chars if ord(c) < 0x300 and c.isalpha()]
        + [c for c in chars if 0x1E00 <= ord(c) <= 0x1EFF],
        "hangul": [chr(c) for c in range(0xAC00, 0xD7A4, 37)],
        "cjk": [chr(c) for c in range(0x4E00, 0xA000, 97)],
    }
    for name, group in groups.items():
        for lang in ("eng", "deu", "tur", "kor", "cmn"):
            single = {c: table["languages"].get(lang, {}).get(c, table["base"].get(c, "")) for c in group}
            bad = [a + b for a, b in itertools.product(group, group) if rom(a + b, lang) != single[a] + single[b]]
            if bad:
                raise SystemExit(f"{name}/{lang}: {len(bad)} pairs romanize with context, e.g. {bad[:5]}")
            print(f"  {name}/{lang}: {len(group) ** 2} pairs romanize character by character", flush=True)


def _lyric_lines(found: dict[str, set[str]], limit: int) -> list[tuple[str, str]]:
    """Lines of real lyric words (as charted: casing, punctuation, digits) in random order, so no song's lyrics end
    up in the fixtures."""
    codes = {"english": "eng", "german": "deu", "french": "fra", "spanish": "spa", "italian": "ita", "polish": "pol"}
    rng = random.Random(0)
    out = []
    for lang, code in codes.items():
        pool = sorted(w for w in found.get(lang, set()) if w)
        out += (
            [(" ".join(rng.choice(pool) for _ in range(rng.randint(1, 12))), code) for _ in range(limit)]
            if pool
            else []
        )
    return out


def _random_words(chars: list[str], n: int) -> list[tuple[str, str]]:
    rng = random.Random(1)
    latin = [c for c in chars if ord(c) < 0x2000]
    hangul = [chr(c) for c in range(0xAC00, 0xD7A4)]
    cjk = [chr(c) for c in range(0x4E00, 0xA000)]
    symbols = [c for c in chars if 0x2000 <= ord(c) < 0x3040]
    out = []
    for i in range(n):
        pool, lang = [(latin, "eng"), (latin, "tur"), (hangul, "kor"), (cjk, "cmn"), (latin + symbols, "deu")][i % 5]
        words = ["".join(rng.choice(pool) for _ in range(rng.randint(1, 7))) for _ in range(rng.randint(1, 4))]
        out.append((" ".join(words), lang))
    return out


def _members(char_class: str) -> str:
    """Every character a Python regex class body matches."""
    pattern = re.compile("[" + char_class + "]")
    return "".join(c for c in map(chr, range(0x110000)) if not 0xD800 <= ord(c) <= 0xDFFF and pattern.fullmatch(c))


def _write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")


def aligner_text(charting: Path, found: dict[str, set[str]]) -> None:
    from ctc_forced_aligner.norm_config import norm_config
    from ctc_forced_aligner.text_utils import preprocess_text

    rom = _Romanizer()
    chars = _characters()
    table = _tables(rom, chars)
    languages = {k: len(v) for k, v in table["languages"].items()}
    print(f"{len(chars)} characters, {len(table['base'])} romanize to letters; languages with differences: {languages}")
    _check_pairs(rom, chars, table)
    config = norm_config["*"]
    data = {
        "uroman": importlib.metadata.version("uroman"),  # the version that made the table
        "normalization": {
            "unicode": config["unicode_norm"],
            # The sets are Python regex classes (with escapes JavaScript rejects, and stray text from comments in
            # punctuations.lst: "7355" and an Arabic character name, so 7, 3 and 5 count as punctuation): written
            # out as the exact characters each one matches.
            "punctuation": _members(config["punc_set"]),
            "delete": _members(config["del_set"]),
            "digits": _members(config["digit_set"]),
            "mappings": list(config["mapping"].items()),
        },
        "romanization": table,
    }
    _write(charting / "data" / "aligner-text.json", data)
    cases = []
    for text, lang in _lyric_lines(found, 300) + _random_words(chars, 3000):
        tokens, _ = preprocess_text(text, romanize=True, language=lang, split_size="word")
        cases.append([text, lang, [t for t in tokens if t != "<star>"]])
    _write(charting / "fixtures" / "aligner-text.json", cases)
    print(f"aligner-text.json: {len(cases)} cases", flush=True)


def export(charting: Path, per_language: int = 6000) -> None:
    """Write data/aligner-text.json and the fixtures."""
    found = _chart_words()
    words = syllable_words(found, per_language)
    rows = [[w, lang, lyrics.syllabify(w, lang)] for w, lang in words]
    _write(charting / "fixtures" / "syllables.json", rows)
    print(f"syllables.json: {len(rows)} words")
    (charting / "fixtures" / "numpy.json").write_text(json.dumps(numpy_reference()) + "\n")
    aligner_text(charting, found)


def syllable_tables(folder: Path) -> None:
    """Learn the syllable tables from the train split's charts (so dev and test charts don't teach the splits they are
    scored on) and report how often they split dev words like the charter."""

    def charts(split: str) -> list[Path]:
        return [p for s in splits.songs(split) for p in library.folder(s).glob("*.txt")]

    train, dev = charts("train"), charts("dev")
    folder.mkdir(parents=True, exist_ok=True)
    for language in TABLE_LANGUAGES:
        table = syllables.learn(train, language)
        split = syllables.Syllabifier(language, table)
        total = right = 0
        for path in dev:
            song = ultrastar.parse(path)
            if song.headers.get("LANGUAGE", "").split(",")[0].strip().lower() != language:
                continue
            for w in lyrics.words_from_song(song):
                truth = syllables.chart_split(w)
                if truth:
                    total += 1
                    right += [syllables.normalize(p) for p in split.split("".join(truth))] == truth
        syllables.save(table, folder / f"syllables-{language}.json")
        print(f"{language}: {len(table)} words from {len(train)} train charts; dev words split like the charter: "
              f"{right / max(total, 1):.1%} of {total}")  # fmt: skip
