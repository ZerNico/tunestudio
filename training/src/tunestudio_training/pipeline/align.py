"""Forced alignment of known lyrics to the vocal stem (MMS-300m CTC aligner, 1100+ languages via romanization).

Gives per-word spans and, inside each word, per-character spans, which is what syllable timing is derived from.
"""

import re
from dataclasses import dataclass
from functools import cache

import numpy as np
import torch

from tunestudio_training import paths

from . import onnx_models
from .audio import load
from .pitch import device

SR = 16000

# ISO 639-3 codes the aligner's romanizer/normalizer expects.
LANGUAGES = {"english": "eng", "german": "deu", "french": "fra", "spanish": "spa", "dutch": "nld", "italian": "ita"}


@dataclass
class WordTiming:
    text: str
    start: float
    end: float
    score: float  # mean log-prob, closer to 0 is more confident
    chars: list[tuple[float, float]]  # per romanized character

    def time_at(self, fraction: float) -> float:
        """Start time of the character at `fraction` through the word (0..1), for syllable boundaries."""
        if not self.chars:
            return self.start + fraction * (self.end - self.start)
        i = min(int(round(fraction * len(self.chars))), len(self.chars) - 1)
        return self.chars[i][0]


def snap_to_voice(words: list[WordTiming], midi: np.ndarray, rms: np.ndarray, hop: float, drop: float = 20.0) -> None:
    """Move word starts to where singing actually begins inside the aligned span (in place).

    The aligner often stretches a line's first word back over the silence before it (seconds, for short words
    like "I"/"Oh"/"The"). UltraStar notes start at the sung vowel anyway, so the first voiced, loud frame is the
    better start. `rms` threshold is relative to the song's loud singing.
    """
    loud = np.nanpercentile(rms[~np.isnan(midi)], 90) - drop if (~np.isnan(midi)).any() else -np.inf
    sung = ~np.isnan(midi) & (rms > loud)
    for w in words:
        a, b = int(w.start / hop), int(w.end / hop)
        idx = np.flatnonzero(sung[a:b])
        if len(idx) and idx[0] > 0:
            w.start = (a + idx[0]) * hop


def pull_in_edges(words: list[WordTiming], max_gap: float = 0.8, length: float = 0.3) -> None:
    """Re-place a line's first/last word when it sits far apart from the rest of the line (in place).

    The aligner parks a line's edge word on unrelated sound (a breath, an ad-lib, the intro) seconds away
    from the rest of the line. Inside a line words follow each other closely, so a big gap at the edge is an
    alignment error; the word is moved next to its neighbour, where `snap_to_voice` then finds the onset.
    """
    if len(words) < 2:
        return
    first, second = words[0], words[1]
    if second.start - first.end > max_gap:
        first.start, first.end = max(first.end, second.start - length), second.start
        first.chars = []
    last, before = words[-1], words[-2]
    if last.start - before.end > max_gap:
        last.start = before.end
        last.end = max(last.start + length, min(last.end, last.start + 2.0))
        last.chars = []


def model_path() -> str:
    """The CTC aligner: MMS fine-tuned on sung lines (`tst train aligner`), much better syllable timing on singing than
    the stock speech model. TST_ALIGNER (or models.aligner in tst.toml) overrides the default
    `<TST_MODELS>/aligner/aligner-ft2`."""
    return str(paths.aligner())


@cache
def _model():
    from ctc_forced_aligner import load_alignment_model

    # The aligner's emission step isn't reliable on MPS; CPU is fine for a 3 minute song.
    dev = "cuda" if device() == "cuda" else "cpu"
    return load_alignment_model(dev, model_path=model_path(), dtype=torch.float16 if dev == "cuda" else torch.float32)


@cache
def _tokenizer():
    """The aligner's tokenizer; the ONNX export carries a copy of it."""
    if onnx_models.folder():
        from transformers import AutoTokenizer

        return AutoTokenizer.from_pretrained(
            str(onnx_models.folder() / "tunestudio-aligner"), word_delimiter_token=None
        )
    return _model()[1]


def is_word(text: str) -> bool:
    return re.search(r"\w", text) is not None


def _parts(word: str) -> list[str]:
    """What the aligner should see for one lyric word: no melisma markers, and vocalisations like
    "oh–oh–oh" split up so a single token can't swallow seconds of audio."""
    return [p for p in re.split(r"[-–—]+", word.replace("~", "")) if is_word(p)]


@dataclass
class Line:
    words: list[str]
    # Rough time window, e.g. from line-synced lyrics (LRCLIB) or a transcription. None = whole song.
    start: float | None = None
    end: float | None = None


@cache
def emissions(vocals_path: str) -> tuple[torch.Tensor, float]:
    """CTC log-probs for the whole stem, computed once and sliced per line. Returns (frames x vocab, stride ms)."""
    from ctc_forced_aligner import generate_emissions

    if onnx_models.folder():
        return onnx_models.emissions(vocals_path)
    model, _ = _model()
    audio = torch.from_numpy(load(vocals_path, SR).copy()).to(model.device, model.dtype)
    with torch.no_grad():
        return generate_emissions(model, audio, batch_size=8)


def align(vocals_path: str, lines: list[Line], language: str, pad: float = 1.5) -> list[list[WordTiming]]:
    """Align each line inside its window (widened by `pad` seconds), one timing per `is_word` word.

    Aligning line by line keeps an ad-lib or a backing vocal the lyrics don't contain from dragging every
    following word along, which is what happens when aligning the whole song in one go.
    """
    em, stride = emissions(vocals_path)
    frame = stride / 1000
    result = []
    for line in lines:
        words = [w for w in line.words if is_word(w)]
        if not words:
            result.append([])
            continue
        lo = 0 if line.start is None else max(0, int((line.start - pad) / frame))
        hi = len(em) if line.end is None else min(len(em), int((line.end + pad) / frame) + 1)
        parts = [_parts(w) for w in words]
        flat = _align_tokens(em[lo:hi], stride, [p for ps in parts for p in ps], language, offset=lo * frame)
        timings, i = [], 0
        for word, ps in zip(words, parts):
            pieces = flat[i : i + len(ps)]
            i += len(ps)
            chars = [c for p in pieces for c in p.chars]
            score = float(np.mean([p.score for p in pieces]))
            timings.append(WordTiming(word, pieces[0].start, pieces[-1].end, score, chars))
        result.append(timings)
    return result


def _align_tokens(em: torch.Tensor, stride: float, words: list[str], language: str, offset: float) -> list[WordTiming]:
    from ctc_forced_aligner import get_alignments, get_spans, preprocess_text

    tokenizer = _tokenizer()
    lang = LANGUAGES.get(language.lower(), language)
    tokens, text = preprocess_text(" ".join(words), romanize=True, language=lang, split_size="word")
    segments, scores, blank = get_alignments(em, tokens, tokenizer)
    spans = get_spans(tokens, segments, blank)

    result = []
    to_sec = stride / 1000
    for i, t in enumerate(text):
        if t == "<star>":
            continue
        span = spans[i]
        # Spans are padded with blank segments up to half the gap to the neighbours; only real characters count.
        chars = [
            (offset + s.start * to_sec, offset + (s.end + 1) * to_sec) for s in span if s.label not in (blank, "|", " ")
        ]
        if chars:
            start, end = chars[0][0], chars[-1][1]
        else:
            start, end = offset + span[0].start * to_sec, offset + (span[-1].end + 1) * to_sec
        score = float(np.mean(scores[span[0].start : span[-1].end + 1]))
        result.append(WordTiming(t, start, end, score, chars))
    return result
