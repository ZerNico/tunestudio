"""Golden notes (UltraStar `*`, double points): which of a chart's notes to mark.

Two methods, chosen by the `golden` chart option (see `mark`):

- "model", the default and what Tune Studio ships: gradient-boosted trees learned from hand-made charts (`tst golden
  train`). They score every note from the per-note `features` below, and the song gets as many golden notes as the
  probabilities add up to (the expected number), picked by a few plain rules (`pick`: a golden group starts on a
  syllable and keeps its melisma together, spread over the song). The shipped trees (recipes.SHIPPED) are exported to
  ONNX as tunestudio-note-refiners' golden.onnx, which this runs instead with TST_ONNX. Tune Studio runs that file in
  its native addon and ports the rest of this module to TypeScript (electron/charting/golden.ts). `tst golden train
  --linear` makes a logistic regression instead (a JSON table, `load_model`), kept to compare against.
- "rule": `chart.mark_golden`, 5% of the notes, at least 0.4 s long, the most steadily sung first, spread over the
  song (what shipped before the model, kept to compare against).

Both run on the finished lines (after line splitting and the clean-up in `chart.build_song`), so that "the last note
of a line" is the line the player sees, and so that `tst golden rescore` can re-mark the charts of an existing
evaluation run without charting again.

What the train charts say (2,665 songs): 90% have golden notes, a median 4.4% of their notes (15 notes) where they
have any, but that varies with the charter far more than with the song. Golden notes are long for their song (median
length rank 0.80) without being long in seconds (median 0.23 s, 75% are shorter than 0.4 s, so the rule's minimum
misses most of them). They sit higher (median +1 semitone over the song's median note, 43% are the highest note of
their line), end lines and phrases more often (24% vs 16%), and 56% of them come in runs of consecutive golden notes
(a melisma, a whole word). On our notes, where one matches a golden note, the rest of its melisma does 63% of the
time and the rest of its word 46%. Charters don't gild repeated lines consistently: only 9% of repeated lines with a
golden note have the same ones in every repeat, and of the lines that come back, 26% are gilded once and 19% more
than once (of those that come back at least three times, 6% every time). Two charters of one song agree at about F1
0.17, so no method gets far above that against one chart.

The features merge three studies (2026-10-20): the note's length against the song, its line, its phrase and its
neighbours, how steadily and loudly it is sung, its pitch against the song, the line, the phrase and its neighbours,
where it sits in its line and phrase, and its melisma. Phrases are the notes between line breaks or rests of at least
PHRASE_REST, so they don't depend on how the chart splits lines. A melisma is a syllable's note and the "~" notes
after it in the same phrase.
"""

import json
from pathlib import Path

import numpy as np

from tunestudio_training import paths, recipes

from . import chart, onnx_models
from .chart import Grid
from .pitch import HOP_SEC, PitchTrack
from .ultrastar import Note

PHRASE_REST = 0.3  # seconds of rest that end a phrase
# The shipped trees (recipes.SHIPPED["golden"], 2026-10-21) are fitted on the 2,302 train songs of the 2026-10-09
# dump run. On dev+sel they beat the linear table m2 by golden F1 +0.016 (0.183 vs 0.167, CI +0.003 to +0.030); the
# table gains nothing from more songs, the trees stop gaining at about 1,100, and bigger trees (800 iterations of 63
# leaves, 1,500 of 127) scored lower. Retraining on today's pipeline (464 songs of a new dump against the same 464 of
# the old one) left the table's dev and sel within 0.004.
# How the "model" method picks (see `pick`). `tst golden train` writes it into the model. Decided on held-out
# train artists (2026-10-20, 479 songs), against the first model's pick (m1: start "any", runs 1.0, no spread):
# - start "syllable", runs 0.7: golden groups start on a syllable, melismas whole unless their tail is clearly less
#   likely. "~" groups without their syllable drop from 17.6% of the groups to 1.2% (charters: 7.3%), and the golden
#   notes look more like a charter's (classifier AUC 0.784 -> 0.747). It costs golden F1 0.007 (0.205 -> 0.197, CI
#   -0.012 to -0.003): a lone "~" of ours often overlaps a charter's golden note that our chart cuts differently, and
#   its syllable rarely does (13%). Runs 0.5 to 0.8 or whole melismas looked more like a charter's again (AUC down to
#   0.71) and cost more F1 (up to 0.028).
# - spread 0.25: F1 +0.001, no tenth of the song gets more than a quarter of the golden notes.
# - repeat_cap stays off: charters gild repeated lines about as often as we do (61% of their gilded lines are
#   repeated lines, ours 66%) and capping costs F1 (3 lines: -0.007, 2: -0.015, 1: -0.029 more). Scale (the count)
#   stays 1: a song-level count model on the song's length, repeats and melismas barely beat a constant (mean error of
#   the log count ratio 0.553 vs 0.566), and the charter's taste sets most of the count.
PICK = {"scale": 1.0, "runs": 0.7, "spread": 0.25, "start": "syllable", "repeat_cap": None}
UNITS_PER_BEAT = 16  # chart beats per real beat (chart.make_grid), for the beat phase

# One row per sung note. Lengths are in seconds, or as a log of a ratio ("vs"), pitches in semitones, loudness in dB
# of the pitch track's rms, relative to the song's (or line's, phrase's) median over the sung notes. Ranks are
# percentiles within the song. The app's port computes the same columns in the same order.
FEATURES = (
    # length
    "sec", "log_sec", "len_rank", "vs_line_max", "vs_phrase_max", "vs_local", "vs_prev", "vs_next",
    # how it is sung
    "on_pitch", "on_frac", "pitch_spread", "voiced", "wobble", "slope", "loud", "loud_line", "loud_phrase",
    # pitch
    "rel_pitch", "pitch_rank", "below_line_high", "rel_line", "line_peak", "phrase_peak", "below_phrase_peak",
    "local_peak", "rise", "fall",
    # place
    "line_last", "line_from_end", "line_pos", "line_notes", "log_line_sec", "phrase_first", "phrase_last",
    "phrase_from_end", "phrase_notes", "log_phrase_sec", "gap_before", "gap_after", "song_pos", "beat_sin",
    "beat_cos",
    # syllables and melismas
    "tilde", "word_end", "log_word_sec", "mel_size", "mel_index", "log_mel_sec", "mel_range",
    # the song
    "log_song_notes",
)  # fmt: skip
# The model's terms: every feature, the square of every feature that isn't a yes/no flag (so a feature can matter
# most in its middle, like a length rank), and the products of every two PAIRED features (a long note matters more at
# the end of a line). On held-out train artists these bring a logistic regression from within-song AUC 0.743 to
# 0.754, next to gradient-boosted trees' 0.758 on the same features.
FLAGS = ("line_peak", "phrase_peak", "line_last", "phrase_first", "phrase_last", "tilde", "word_end")
PAIRED = (
    "len_rank", "on_frac", "loud", "rel_pitch", "line_last", "phrase_last", "line_peak", "tilde", "mel_size",
    "vs_local", "gap_after", "log_song_notes", "pitch_rank", "loud_phrase", "rel_line", "word_end", "song_pos",
    "log_sec",
)  # fmt: skip


def sung_notes(lines: list[list[Note]]) -> list[tuple[int, int, Note]]:
    """(line index, index in the line's sung notes, note) of every normal or golden note."""
    out = []
    for li, line in enumerate(lines):
        sung = [n for n in line if n.type in ("normal", "golden")]
        out += [(li, i, n) for i, n in enumerate(sung)]
    return out


def _rank(x: np.ndarray) -> np.ndarray:
    """Percentile rank in [0, 1], equal values share their mean rank."""
    if len(x) < 2:
        return np.zeros(len(x))
    _, inverse, counts = np.unique(x, return_inverse=True, return_counts=True)
    first = np.concatenate([[0], np.cumsum(counts)[:-1]])
    return (first + (counts - 1) / 2)[inverse] / (len(x) - 1)


def _groups(ids: np.ndarray) -> list[np.ndarray]:
    """Indices of each run of equal consecutive ids."""
    cuts = np.flatnonzero(np.diff(ids)) + 1
    return np.split(np.arange(len(ids)), cuts)


def lyrics_key(line: list[Note]) -> str:
    """A line's lyrics for finding repeated lines: its sung notes' text without "~", lower case, letters and digits
    only ("Wann ist der Mann~ ein Mann?~~" -> "wannistdermanneinmann")."""
    text = "".join(n.text for n in line if n.type in ("normal", "golden")).replace("~", "").lower()
    return "".join(c for c in text if c.isalnum())


def structure(lines: list[list[Note]], grid: Grid) -> dict[str, np.ndarray]:
    """Per sung note: start and end (s), MIDI pitch, line, phrase and melisma ids, "~" and word-end flags, and "text":
    the index of the first line with the same lyrics (`lyrics_key`, at least 4 characters, else the note's own
    line), so repeats of a line share it."""
    notes = sung_notes(lines)
    start = np.array([grid.to_sec(n.start) for _, _, n in notes])
    end = np.array([grid.to_sec(n.start + n.length) for _, _, n in notes])
    line = np.array([li for li, _, _ in notes], int)
    gap = start[1:] - end[:-1]
    new_phrase = np.ones(len(notes), bool)
    new_phrase[1:] = (line[1:] != line[:-1]) | (gap >= PHRASE_REST)
    tilde = np.array([n.text.strip().startswith("~") for _, _, n in notes], bool)
    word_end = np.array([n.text.endswith(" ") for _, _, n in notes], bool) | np.append(new_phrase[1:], True)
    first_with: dict[str, int] = {}
    text = []
    for li, ln in enumerate(lines):
        key = lyrics_key(ln)
        text.append(first_with.setdefault(key, li) if len(key) >= 4 else li)
    return {
        "start": start,
        "end": end,
        "midi": np.array([n.midi for _, _, n in notes], float),
        "beat": np.array([n.start for _, _, n in notes], float),
        "line": line,
        "phrase": np.cumsum(new_phrase) - 1,
        "melisma": np.cumsum(~tilde | new_phrase) - 1,  # a "~" that starts a phrase starts its own melisma
        "tilde": tilde,
        "word_end": word_end,
        "text": np.array([text[li] for li in line], int),
    }


def _sung(s: dict, track: PitchTrack, tuning: float) -> dict[str, np.ndarray]:
    """How each note is sung, from the pitch track: seconds within half a semitone of the note's pitch class, the
    spread of the distance to it, the voiced share, the wobble around a straight line through the sung pitch and
    that line's slope (semitones per second), and the mean loudness (dB, NaN without a loudness track)."""
    n = len(s["start"])
    out = {k: np.zeros(n) for k in ("on_pitch", "pitch_spread", "voiced", "wobble", "slope")}
    out["loud"] = np.full(n, np.nan)
    for k in range(n):
        i, j = np.searchsorted(track.times, [s["start"][k], s["end"][k]])
        f = track.midi[i:j] - tuning
        ok = ~np.isnan(f)
        v = f[ok]
        d = np.abs(v - s["midi"][k]) % 12
        d = np.minimum(d, 12 - d)
        out["on_pitch"][k] = np.sum(d <= 0.5) * HOP_SEC
        out["pitch_spread"][k] = np.std(d) if len(d) >= 3 else 6.0
        out["voiced"][k] = ok.mean() if j > i else 0.0
        if len(v) >= 4:
            t = np.arange(len(v)) * HOP_SEC
            slope, icpt = np.polyfit(t, v, 1)
            out["slope"][k] = min(abs(slope), 40.0)
            out["wobble"][k] = min(float(np.std(v - (slope * t + icpt))), 3.0)
        if track.rms is not None and j > i:
            out["loud"][k] = float(np.mean(track.rms[i:j]))
    return out


def features(lines: list[list[Note]], grid: Grid, track: PitchTrack, tuning: float) -> np.ndarray:
    """One row of FEATURES per sung note, in `sung_notes` order (float32)."""
    s = structure(lines, grid)
    n = len(s["start"])
    if n == 0:
        return np.zeros((0, len(FEATURES)), np.float32)
    sec = np.maximum(s["end"] - s["start"], 1e-3)
    midi, line, phrase = s["midi"], s["line"], s["phrase"]
    sung = _sung(s, track, tuning)
    loud = sung["loud"]
    loud = loud - np.nanmedian(loud) if np.isfinite(loud).any() else np.zeros(n)
    loud = np.nan_to_num(loud, nan=-30.0)  # a note without frames: as quiet as a rest
    X = np.zeros((n, len(FEATURES)))
    F = {name: X[:, i] for i, name in enumerate(FEATURES)}

    F["sec"][:] = sec
    F["log_sec"][:] = np.log(sec)
    F["len_rank"][:] = _rank(sec)
    for k in range(n):
        lo, hi = max(0, k - 5), min(n, k + 6)
        F["vs_local"][k] = np.log(sec[k] / np.median(sec[lo:hi]))
    same_prev = np.r_[False, line[1:] == line[:-1]]
    same_next = np.r_[line[:-1] == line[1:], False]
    prev_sec, next_sec = np.r_[sec[0], sec[:-1]], np.r_[sec[1:], sec[-1]]
    F["vs_prev"][:] = np.where(same_prev, np.log((sec + 0.03) / (prev_sec + 0.03)), 0)
    F["vs_next"][:] = np.where(same_next, np.log((sec + 0.03) / (next_sec + 0.03)), 0)

    F["on_pitch"][:] = sung["on_pitch"]
    F["on_frac"][:] = sung["on_pitch"] / np.maximum(sec, HOP_SEC)
    for name in ("pitch_spread", "voiced", "wobble", "slope"):
        F[name][:] = sung[name]
    F["loud"][:] = loud

    med = float(np.median(midi))
    F["rel_pitch"][:] = np.clip(midi - med, -12, 12)
    F["pitch_rank"][:] = _rank(midi)
    prev_pitch, next_pitch = np.r_[midi[0], midi[:-1]], np.r_[midi[1:], midi[-1]]
    F["rise"][:] = np.where(same_prev, np.clip(midi - prev_pitch, -12, 12), 0)
    F["fall"][:] = np.where(same_next, np.clip(midi - next_pitch, -12, 12), 0)
    for k in range(n):
        nb = np.r_[midi[max(0, k - 2) : k], midi[k + 1 : k + 3]]
        F["local_peak"][k] = np.clip(midi[k] - nb.max(), -12, 12) if len(nb) else 0

    for idx in _groups(line):
        m = len(idx)
        F["vs_line_max"][idx] = np.log(sec[idx] / sec[idx].max())
        F["loud_line"][idx] = loud[idx] - np.median(loud[idx])
        F["below_line_high"][idx] = midi[idx].max() - midi[idx]
        F["rel_line"][idx] = midi[idx] - midi[idx].mean()
        F["line_peak"][idx] = midi[idx] == midi[idx].max()
        F["line_last"][idx[-1]] = 1
        F["line_from_end"][idx] = np.minimum(np.arange(m)[::-1], 4)
        F["line_pos"][idx] = np.arange(m) / max(m - 1, 1)
        F["line_notes"][idx] = m
        F["log_line_sec"][idx] = np.log(max(s["end"][idx[-1]] - s["start"][idx[0]], 0.05))
    for idx in _groups(phrase):
        m = len(idx)
        F["vs_phrase_max"][idx] = np.log(sec[idx] / sec[idx].max())
        F["loud_phrase"][idx] = loud[idx] - np.median(loud[idx])
        F["phrase_peak"][idx] = midi[idx] == midi[idx].max()
        F["below_phrase_peak"][idx] = midi[idx].max() - midi[idx]
        F["phrase_first"][idx[0]] = 1
        F["phrase_last"][idx[-1]] = 1
        F["phrase_from_end"][idx] = np.minimum(np.arange(m)[::-1], 4)
        F["phrase_notes"][idx] = m
        F["log_phrase_sec"][idx] = np.log(max(s["end"][idx[-1]] - s["start"][idx[0]], 0.05))
    for idx in _groups(s["melisma"]):
        F["mel_size"][idx] = min(len(idx), 8)
        F["mel_index"][idx] = np.minimum(np.arange(len(idx)), 7)
        F["log_mel_sec"][idx] = np.log(max(s["end"][idx[-1]] - s["start"][idx[0]], 0.05))
        F["mel_range"][idx] = min(midi[idx].max() - midi[idx].min(), 12)
    # words: a word runs to its note with a trailing space (or the phrase's end)
    w0 = 0
    for k in range(n):
        if s["word_end"][k]:
            F["log_word_sec"][w0 : k + 1] = np.log(max(s["end"][k] - s["start"][w0], 0.05))
            w0 = k + 1

    gaps = s["start"][1:] - s["end"][:-1]
    F["gap_before"][:] = np.clip(np.r_[3.0, gaps], 0, 3)
    F["gap_after"][:] = np.clip(np.r_[gaps, 3.0], 0, 3)
    first, last = s["start"][0], max(s["end"][-1], s["start"][0] + 1)
    F["song_pos"][:] = (s["start"] - first) / (last - first)
    phase = 2 * np.pi * np.mod(s["beat"], UNITS_PER_BEAT) / UNITS_PER_BEAT
    F["beat_sin"][:], F["beat_cos"][:] = np.sin(phase), np.cos(phase)
    F["tilde"][:] = s["tilde"]
    F["word_end"][:] = s["word_end"]
    F["log_song_notes"][:] = np.log(n)
    return X.astype(np.float32)


def terms() -> list[list[str]]:
    """The model's terms, each a list of the FEATURES it multiplies: each feature, the squares and the pairs."""
    squares = [[f, f] for f in FEATURES if f not in FLAGS]
    pairs = [[a, b] for i, a in enumerate(PAIRED) for b in PAIRED[i + 1 :]]
    return [[f] for f in FEATURES] + squares + pairs


def expand(X: np.ndarray, terms: list[list[str]]) -> np.ndarray:
    """The terms' values: per term, the product of its features' columns of X."""
    col = {f: i for i, f in enumerate(FEATURES)}
    out = np.ones((len(X), len(terms)))
    for t, names in enumerate(terms):
        for f in names:
            out[:, t] *= X[:, col[f]]
    return out


def shipped_model() -> dict:
    """The shipped model: its golden.onnx with TST_ONNX, else its pickle in TST_MODELS."""
    if onnx_models.folder():
        return {"features": list(FEATURES), "pick": dict(PICK), "trees": onnx_models.Golden()}
    return load_model(paths.models() / "golden" / f"{recipes.SHIPPED['golden']}.pkl")


def load_model(path: str | Path) -> dict:
    """A golden-note model from `tst golden train`: gradient-boosted trees over FEATURES (a scikit-learn pickle with
    the picking options, "pick", alongside), or with `--linear` a JSON table: the feature names (FEATURES, in order),
    the terms (lists of feature names to multiply), per term its standardization ("mean", "scale") and weight
    ("coef"), the "intercept", and "pick"."""
    path = Path(path)
    if path.suffix == ".pkl":
        import pickle

        with open(path, "rb") as f:
            model = pickle.load(f)
    else:
        model = json.loads(path.read_text())
    if list(model["features"]) != list(FEATURES):
        raise ValueError(f"{path} was trained on other features than pipeline.golden.FEATURES: train it again")
    return model


def probabilities(model: dict, X: np.ndarray) -> np.ndarray:
    """How likely a charter gilds each note: the trees (or the logistic regression over the standardized terms). As
    float64, so that their sum (the golden count) adds up like the app's, also from golden.onnx's float32."""
    if "trees" in model:
        return model["trees"].predict_proba(X)[:, 1].astype(np.float64)
    T = (expand(X, model["terms"]) - np.asarray(model["mean"])) / np.asarray(model["scale"])
    return 1 / (1 + np.exp(-(T @ np.asarray(model["coef"]) + model["intercept"])))


def pick(
    proba: np.ndarray,
    s: dict[str, np.ndarray],
    scale: float = 1.0,
    runs: float | None = None,
    spread: float | None = None,
    start: str = "any",
    repeat_cap: int | None = None,
) -> np.ndarray:
    """Indices of the golden notes: about round(`scale` * sum of `proba`) notes (the expected number of golden notes,
    so a song where nothing stands out gets few), the most likely first. `s` is the song's `structure`.

    `start` says where a golden group may begin:

    - "syllable": a group always starts on a syllable's note, never on a "~" in the middle of a melisma. Each melisma
      is one candidate: its first notes up to the note where their mean probability is highest (the longest of equal
      means), then on through every next note that keeps the mean at least `runs` times that best mean (0.7 keeps a
      melisma together unless its tail is clearly less likely). Candidates are taken by that mean, whole, so the last
      one may pass the number by a note or two.
    - "any": every note is a candidate on its own (a "~" too). With `runs`, a picked note brings its whole melisma
      along when the melisma's mean probability is at least `runs` times the note's own, cut at the number.

    `spread`: no tenth of the song takes more than this share of the golden notes (at least one). `repeat_cap`: at most
    this many lines with the same lyrics (`structure`'s "text") get golden notes."""
    n = len(proba)
    want = int(round(scale * float(np.sum(proba))))
    if want <= 0 or n == 0:
        return np.zeros(0, int)
    first, last = s["start"][0], max(s["end"][-1], s["start"][0] + 1)
    pos = (s["start"] - first) / (last - first)
    cap = max(1, int(np.ceil(spread * want))) if spread else want
    if start == "syllable":
        candidates = []
        for g in _groups(s["melisma"]):
            mean = np.cumsum(proba[g]) / np.arange(1, len(g) + 1)
            j = len(g) - 1 - int(np.argmax(mean[::-1]))
            while runs is not None and j + 1 < len(g) and mean[j + 1] >= runs * mean[j]:
                j += 1
            candidates.append((float(mean[j]), g[: j + 1]))
    elif start == "any":
        candidates = [(float(p), np.array([k])) for k, p in enumerate(proba)]
    else:
        raise ValueError(f"unknown golden pick start {start!r}")
    taken = np.zeros(n, bool)
    per_tenth = np.zeros(10, int)
    gilded: dict[int, set[int]] = {}  # lyrics -> the lines with them that have golden notes
    for c in np.argsort([-score for score, _ in candidates], kind="stable"):
        left = want - int(taken.sum())
        if left <= 0:
            break
        spot = candidates[c][1]
        k = int(spot[0])
        if taken[k]:
            continue
        if start == "any" and runs is not None:
            group = np.flatnonzero(s["melisma"] == s["melisma"][k])
            if len(group) > 1 and proba[group].mean() >= runs * proba[k]:
                spot = group[~taken[group]][:left]
        tenth = min(9, int(10 * pos[k]))
        if per_tenth[tenth] >= cap:
            continue
        line, text = int(s["line"][k]), int(s["text"][k])
        same = gilded.setdefault(text, set())
        if repeat_cap is not None and line not in same and len(same) >= repeat_cap:
            continue
        taken[spot] = True
        per_tenth[tenth] += len(spot)
        same.add(line)
    return np.flatnonzero(taken)


def mark(lines: list[list[Note]], grid: Grid, track: PitchTrack, tuning: float, options: dict) -> None:
    """Re-mark the golden notes of finished lines. `options` (the `golden` chart option): {"method": "model"} (the
    default) with optionally "model", another `tst golden train` model than the shipped one, and any of `pick`'s options
    ("scale", "runs", "spread", "start", "repeat_cap") to override the table's, or {"method": "rule"}."""
    for line in lines:
        for n in line:
            if n.type == "golden":
                n.type = "normal"
    opts = dict(options)
    method = opts.pop("method", "model")
    if method == "rule":
        chart.mark_golden(lines, grid, track, tuning)
        return
    if method != "model":
        raise ValueError(f"unknown golden method {method!r}")
    notes = sung_notes(lines)
    if not notes:
        return
    model = load_model(opts.pop("model")) if "model" in opts else shipped_model()
    X = features(lines, grid, track, tuning)
    s = structure(lines, grid)
    picked = pick(probabilities(model, X), s, **{**model["pick"], **opts})
    for k in picked:
        notes[k][2].type = "golden"
