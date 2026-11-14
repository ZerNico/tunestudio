"""Splitting lyric words into sung syllables, the way UltraStar charters do.

Hyphenation (pyphen) is the wrong tool: it never leaves a single letter at a word edge ("a-way", "ü-bern")
and follows typesetting rules, not singing. Charters split per vowel sound. Learning the splits from existing
charts covers the common words; a vowel-group rule handles the rest.
"""

import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path

from tunestudio_training import paths

from .lyrics import Word, words_from_song
from .ultrastar import parse


@dataclass(frozen=True)
class Rules:
    """How one language's spelling marks its sung syllables."""

    vowels: str
    # Letter groups that are one vowel sound, longest first.
    digraphs: tuple[str, ...] = ()
    # Consonant groups that stay together and start the next syllable, longest first.
    onsets: tuple[str, ...] = ()
    # "english": silent final e ("make", "makes", "loved"); "french": silent final e and es ("danse", "aimes").
    final_e: str = ""
    # A y before a vowel is a consonant ("a-yer"), and so is the y ending a group like "ay" before a vowel.
    y_glide: bool = False
    # Japanese: an n that no vowel or y follows is a syllable of its own ("ji-bu-n", "na-n-te").
    moraic_n: bool = False
    # Portuguese: a final "ia", "io", "ua" (...) is two syllables in a word without an accent mark ("di-a", "ri-o"),
    # where the stress falls on its i or u; with one elsewhere it is a single syllable ("me-mó-ria").
    final_hiatus: bool = False
    # A language whose learned splits also apply (romanized K-pop and J-pop charts are full of English words).
    loanwords: str = ""


def _rules(vowels: str, digraphs: str = "", onsets: str = "", **flags) -> Rules:
    """Rules from space-separated groups, sorted longest first (stable, like `sorted(key=len, reverse=True)`)."""

    def by_length(groups: str) -> tuple[str, ...]:
        return tuple(sorted(groups.split(), key=len, reverse=True))

    return Rules(vowels, by_length(digraphs), by_length(onsets), **flags)


# Consonant pairs most spellings keep together at a syllable start: a stop or f before l or r.
LIQUID = "bl br cl cr dr fl fr gl gr pl pr tr"
ACCENTED = "àáâãäåæèéêëìíîïòóôõöøœùúûüýÿāăąēėęěīįıōőūůűų"
CYRILLIC = "аеёиоуыэюяіїє"
GREEK = "αεηιουωάέήίόύώϊϋΐΰ"
ROMANCE_DIPHTHONGS = "ai au ei eu oi ou ia ie io iu ua ue ui uo"

RULES = {
    "english": _rules(
        "aeiouy",
        "eau ai au aw ay ea ee ei eu ew ey ie oa oe oi oo ou ow oy ue ui",
        "sch chr thr shr spr str scr ch sh th ph wh ck qu bl br cl cr dr fl fr gl gr pl pr "
        "sc sk sl sm sn sp st sw tr tw",
        final_e="english",
    ),
    "german": _rules(
        "aeiouyäöü",
        "aa ai au äu ee ei eu ie oo ui",
        "schr sch chr pf ch ck qu st sp bl br dr fl fr gl gr kl kr pl pr tr zw",
    ),
    "spanish": _rules(
        "aeiouáéíóúü",
        f"iai iei uai uei uay uey ay ey oy uy {ROMANCE_DIPHTHONGS} ió ié iá iú ué uá uí uó üe üi",
        f"ch ll rr qu {LIQUID}",
        y_glide=True,
    ),
    "portuguese": _rules(
        "aeiouáàâãéêíóôõúü",
        f"ão ãe õe ãi ao éi éu ói {ROMANCE_DIPHTHONGS} iá ié ió iê iô uá ué uê",
        f"ch lh nh qu {LIQUID} vr",
        y_glide=True,
        final_hiatus=True,
    ),
    "italian": _rules(
        "aeiouàèéìíòóùú",
        f"iei uoi iai uai {ROMANCE_DIPHTHONGS} ià iè iò iù uò uè",
        f"ch gh qu {LIQUID}",
        y_glide=True,
    ),
    "french": _rules(
        "aeiouàâæéèêëîïôœùûü",
        "eau œu ien iel ieu ai au ei eu oi ou ui œ",
        f"ch gn ph th qu ll ss tt mm nn rr pp ff {LIQUID} vr",
        final_e="french",
        y_glide=True,
    ),
    "romanian": _rules(
        "aăâeiîou",
        "eai eau iai ioa ea oa ia ie io iu ua uă ai au ei eu oi ou ui",
        f"ch gh {LIQUID}",
    ),
    "dutch": _rules(
        "aeiouyèéëïöü",
        "aai ooi oei eeu ieu aa ee oo uu ie oe eu ui ei ij ou au",
        "schr sch ch tj bl br dr fl fr gl gr kl kn kr pl pr sl sm sn sp spr st str tr wr zw",
    ),
    "swedish": _rules("aeiouyåäö", "", "skj stj str spr skr sj tj kj st sp sk sh dr tr br gr kr fr fl pl kl gl bl"),
    "norwegian": _rules("aeiouyæøå", "ei øy au", "skj sj kj"),
    "danish": _rules("aeiouyæøå", "ej aj øj", "skj sj"),
    "finnish": _rules(
        "aeiouyäö",
        "aa ee ii oo uu yy ää öö ai ei oi ui yi äi öi au eu iu ou ey äy öy ie uo yö",
    ),
    "polish": _rules(
        "aąeęioóuy",
        "ia ie io iu ią ię ió au eu",
        f"szcz cz sz rz ch dz dź dż {LIQUID} kl kr wr gł kł pł bł śl śm śn śp św",
    ),
    "czech": _rules("aeiouyáéěíóúůý", "ou au eu", f"ch {LIQUID} hl hr kl kr vl vr"),
    "hungarian": _rules("aáeéiíoóöőuúüű", "", "dzs cs dz gy ly ny sz ty zs"),
    "turkish": _rules("aeıioöuü"),
    "indonesian": _rules("aeiou", "ai au oi ei", f"ng ny sy kh {LIQUID}"),
    "malay": _rules("aeiou", "ai au oi", f"ng ny sy kh {LIQUID}"),
    "greek": _rules(
        GREEK,
        "αι ει οι ου υι αυ ευ ηυ αί εί οί ού υί αύ εύ ηύ",
        "μπ ντ γκ τσ τζ στ σπ σκ πρ τρ κρ γρ βρ δρ φρ θρ χρ πλ κλ γλ βλ φλ χλ",
    ),
    # Russian and Ukrainian charts are mostly romanized ("me-nya", "dlya"): a y before a vowel starts the syllable.
    "russian": _rules(
        "aeiouy" + CYRILLIC,
        "iy yy oy ay ey uy",
        "shch zh ch sh ts kh "
        + " ".join(c + "y" for c in "bcdfghklmnprstvz")
        + " ст ск сп пр бр тр др кр гр вр пл бл кл гл",
        y_glide=True,
    ),
    "ukrainian": _rules(
        "aeiouy" + CYRILLIC,
        "iy yy oy ay ey uy",
        "shch zh ch sh ts kh "
        + " ".join(c + "y" for c in "bcdfghklmnprstvz")
        + " ст ск сп пр бр тр др кр гр вр пл бл кл гл",
        y_glide=True,
    ),
    # Romanized Japanese (Hepburn) splits per mora: every vowel, a lone n, a doubled consonant with what follows.
    "japanese": _rules(
        "aeiou",
        "",
        "tch cch ssh tts sh ch ts ky gy ny hy my ry by py kk ss tt pp",
        moraic_n=True,
        loanwords="english",
    ),
    # Romanized Korean (Revised Romanization): its two-letter vowels, doubled and y/w-glided initials.
    "korean": _rules(
        "aeiou",
        "ae eo eu oe ui",
        "kk tt pp ss jj ch "
        + " ".join(c + g for c in ("g", "k", "n", "d", "t", "r", "m", "b", "p", "s", "j", "ch", "h") for g in "yw"),
        loanwords="english",
    ),
    # Pinyin and Jyutping finals.
    "chinese": _rules(
        "aeiouüv",
        "iao iou uai uei eoi eui ai ao ei ou ia ie io iu ua ue ui uo üe ve aa eu oe oi",
        "zh ch sh ng gw kw",
        loanwords="english",
    ),
}
RULES["cantonese"] = RULES["chinese"]
# Any other language: the Latin, Cyrillic and Greek vowels, each its own syllable.
DEFAULT = _rules("aeiou" + ACCENTED + CYRILLIC + GREEK, "", f"qu {LIQUID}", y_glide=True)
# Rising diphthongs a final hiatus splits, and the accented letters that rule it out.
RISING = ("ia", "ie", "io", "ua", "ue", "uo")
MARKED = set("áàâãéêíóôõú")


def language_key(language: str) -> str:
    """A language as the rules know it: lowercase, without a variant ("Portuguese (Brazil)" is "portuguese")."""
    return re.sub(r"\s*\(.*\)$", "", language.strip().lower())


def rules_for(language: str) -> Rules:
    return RULES.get(language_key(language), DEFAULT)


def rules_data() -> dict:
    """The rules as the app reads them (`data/syllable-rules.json`)."""

    def entry(r: Rules) -> dict:
        return {
            "vowels": r.vowels,
            "digraphs": list(r.digraphs),
            "onsets": list(r.onsets),
            "finalE": r.final_e,
            "yGlide": r.y_glide,
            "moraicN": r.moraic_n,
            "finalHiatus": r.final_hiatus,
            "loanwords": r.loanwords,
        }

    return {"languages": {k: entry(v) for k, v in RULES.items()}, "default": entry(DEFAULT)}


WORD = re.compile(r"[^\w']+")
# Writing systems whose characters are syllables (Chinese characters, Hangul) or morae (kana).
SYLLABIC = re.compile(r"[㐀-䶿一-鿿豈-﫿가-힣ぁ-ゖァ-ヺ]")
# Small kana and the long-vowel mark belong to the mora before them.
SMALL_KANA = set("ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶー")


def normalize(word: str) -> str:
    return WORD.sub("", word.lower().replace("’", "'"))


def _syllabic_split(word: str) -> list[str] | None:
    """One syllable per Chinese character, Hangul block or kana mora; anything else stays with its neighbour."""
    if not SYLLABIC.search(word):
        return None
    parts: list[str] = []
    prefix = ""
    for ch in word:
        if SYLLABIC.match(ch) and ch not in SMALL_KANA:
            parts.append(prefix + ch)
            prefix = ""
        elif parts:
            parts[-1] += ch
        else:
            prefix += ch
    if prefix:
        parts.append(prefix)
    return parts


def _nuclei(word: str, language: str) -> list[tuple[int, int]]:
    """(start, end) of each vowel sound in the word."""
    rules = rules_for(language)
    vowels = rules.vowels

    def vowel_at(k: int) -> bool:
        return k < len(word) and word[k] in vowels

    out, i = [], 0
    while i < len(word):
        ch = word[i]
        if ch in vowels and not (ch == "y" and (i == 0 or (rules.y_glide and vowel_at(i + 1)))):
            for d in rules.digraphs:
                if word.startswith(d, i) and not (rules.y_glide and d[-1] == "y" and vowel_at(i + len(d))):
                    out.append((i, i + len(d)))
                    i += len(d)
                    break
            else:
                # "qu": the u belongs to the consonant.
                if ch == "u" and i > 0 and word[i - 1] == "q":
                    i += 1
                    continue
                out.append((i, i + 1))
                i += 1
        elif (
            rules.moraic_n
            and ch == "n"
            and out
            and out[-1][1] == i
            and not vowel_at(i + 1)
            and word[i + 1 : i + 2] != "y"
        ):
            out.append((i, i + 1))
            i += 1
        else:
            i += 1
    if rules.final_e == "english" and len(out) > 1:
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
    if rules.final_hiatus and out and not MARKED.intersection(word):
        s, e = out[-1]
        rest = word[e:]
        if word[s:e] in RISING and rest in ("", "s", "m") and not (s > 0 and word[s - 1] in "qg"):
            out[-1:] = [(s, s + 1), (s + 1, e)]
    if rules.final_e == "french" and len(out) > 1:
        # Charters leave a final e or es unsung ("danse", "elle", "aimes", "poupée").
        s, e = out[-1]
        if word[s:e] == "e" and word[e:] in ("", "s"):
            out.pop()
    return out


def rule_split(word: str, language: str) -> list[str]:
    """Split before the consonants leading into each vowel sound (one consonant or a known onset cluster)."""
    syllabic = _syllabic_split(word)
    if syllabic is not None:
        return syllabic
    low = word.lower()
    nuclei = _nuclei(low, language)
    if len(nuclei) < 2:
        return [word]
    onsets = rules_for(language).onsets
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
        self.language = language_key(language)
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
