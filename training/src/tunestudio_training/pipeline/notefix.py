"""Learned pitch correction for GAME's notes: decide per note whether the charter would write it a semitone or two
away from what we picked (ornaments, slides, sloppy intonation, the song's scale).

A small gradient-boosted classifier over per-note features (GAME's raw pitch, the singer's pitch distribution in
the note, the scale, neighbouring notes) predicts the pitch-class difference to the hand-made chart. Trained with
`tst train notefix` on the pipeline's own notes (`tst dataset notes`). Pitch classes only: octaves are left alone.
"""

import pickle
from functools import cache

import numpy as np

from . import onnx_models
from .pitch import PitchTrack
from .ultrastar import Note

CLASSES = (-2, -1, 0, 1, 2)  # anything else is folded into "keep" (0) for training
FEATURES = (
    "raw_rel",
    "raw_frac",
    "tuning",
    "dur",
    "part",
    "parts",
    "fallback",
    "in_scale_m2",
    "in_scale_m1",
    "in_scale_0",
    "in_scale_p1",
    "in_scale_p2",
    "f_median",
    "f_mean",
    "f_q10",
    "f_q25",
    "f_q75",
    "f_q90",
    "f_std",
    "f_head",
    "f_tail",
    "f_voiced",
    "prev_step",
    "next_step",
)


def fold(x: float) -> float:
    """Pitch-class difference in [-6, 6)."""
    return (x + 6) % 12 - 6


def delta(midi: int, target: int) -> int:
    return int(fold(round(target - midi)))


def features(
    notes: list[Note], trace: list[dict], track: PitchTrack, tuning: float, scale: frozenset[int] | None
) -> list[list[float]]:
    out = []
    for i, (note, tr) in enumerate(zip(notes, trace)):
        p = note.midi
        frames = track.slice(tr["start"], tr["end"])
        v = frames[~np.isnan(frames)] - tuning
        if len(v):
            rel = fold(v - p)
            third = max(1, len(v) // 3)
            stats = [
                float(np.median(rel)),
                float(np.mean(rel)),
                *np.percentile(rel, [10, 25, 75, 90]).tolist(),
                float(np.std(rel)),
                float(np.median(rel[:third])),
                float(np.median(rel[third:] if len(v) > 1 else rel)),
                len(v) / max(len(frames), 1),
            ]
        else:
            stats = [0.0] * 9 + [0.0]
        in_scale = [float(scale is not None and (p + d) % 12 in scale) for d in (-2, -1, 0, 1, 2)]
        prev_step = float(np.clip(p - notes[i - 1].midi, -12, 12)) if i else 0.0
        next_step = float(np.clip(notes[i + 1].midi - p, -12, 12)) if i + 1 < len(notes) else 0.0
        out.append(
            [
                fold(tr["raw"] - p),
                fold(tr["raw"] - tuning - round(tr["raw"] - tuning)),
                tuning,
                tr["end"] - tr["start"],
                tr["part"],
                tr["parts"],
                float(tr["parts"] == 0),
                *in_scale,
                *stats,
                prev_step,
                next_step,
            ]
        )
    return out


@cache
def load(path: str, kind: str = "notefix"):
    """A trained refiner (scikit-learn pickle). With the ONNX exports, the export's model of that kind ("notefix" or
    "ends") instead: `path` then only says that the step runs."""
    if onnx_models.folder():
        return onnx_models.Notefix() if kind == "notefix" else onnx_models.Ends()
    with open(path, "rb") as f:
        return pickle.load(f)


def apply(
    notes: list[Note],
    trace: list[dict],
    track: PitchTrack,
    tuning: float,
    scale: frozenset[int] | None,
    model_path: str,
    threshold: float = 0.5,
) -> None:
    """Shift notes in place where the model is confident (probability of a non-zero class >= threshold)."""
    if not notes:
        return
    clf = load(model_path)
    proba = clf.predict_proba(np.array(features(notes, trace, track, tuning, scale), np.float32))
    classes = list(clf.classes_)
    for note, pr in zip(notes, proba):
        k = int(np.argmax(pr))
        if classes[k] != 0 and pr[k] >= threshold:
            note.pitch += int(classes[k])
