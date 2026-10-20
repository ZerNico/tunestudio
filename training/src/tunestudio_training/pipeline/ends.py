"""Learned note ends: charters end notes earlier than GAME does (median 80ms on dev) and leave a gap before the
next note (median 115ms; half of our gaps are < 30ms). A gradient-boosted regressor over notefix's per-note
features plus the gaps to the neighbours predicts how much earlier/later the hand-made note ends
(`tst train ends`, data from `tst dataset notes`).
"""

import numpy as np

from . import notefix
from .chart import Grid
from .ultrastar import Note

FEATURES = notefix.FEATURES + ("gap_prev", "prev_dur", "gap_next")


def features(base: list[list[float]], starts: list[float], ends: list[float]) -> np.ndarray:
    """notefix features + timing context, one row per note (same order)."""
    out = []
    for i, f in enumerate(base):
        gap_prev = starts[i] - ends[i - 1] if i else 1.0
        prev_dur = ends[i - 1] - starts[i - 1] if i else 0.0
        gap_next = starts[i + 1] - ends[i] if i + 1 < len(starts) else 1.0
        out.append([*f, min(gap_prev, 1.0), prev_dur, min(gap_next, 1.0)])
    return np.array(out, np.float32)


def apply(
    notes: list[Note], trace: list[dict], base: list[list[float]], grid: Grid, model_path: str, gap_units: int = 1
) -> None:
    """Move note ends in place by the predicted amount; at least one beat long, and not past the next note (keeping
    `gap_units` before a new syllable)."""
    if not notes:
        return
    reg = notefix.load(model_path, "ends")
    X = features(base, [t["start"] for t in trace], [t["end"] for t in trace])
    delta = reg.predict(X)
    for i, (note, tr, d) in enumerate(zip(notes, trace, delta)):
        end = grid.to_beat(tr["end"] + float(d))
        if i + 1 < len(notes):
            nxt = notes[i + 1]
            end = min(end, nxt.start - (0 if nxt.text.strip() in ("~", "") else gap_units))
        note.length = max(1, end - note.start)
