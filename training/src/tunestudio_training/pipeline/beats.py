"""Beat and downbeat tracking with Beat This! (CPJKU), on the full mix."""

from dataclasses import dataclass

import numpy as np
import torch

from . import onnx_models
from .audio import load
from .pitch import device

SR = 22050


@dataclass
class Beats:
    beats: np.ndarray  # seconds
    downbeats: np.ndarray  # seconds

    def fit_grid(self, lo: float = 80, hi: float = 160) -> tuple[float, float, float]:
        """Fit one constant tempo to the tracked beats, since UltraStar has a single BPM.

        The tracker flips between a tempo and its double, so instead of averaging intervals this scans candidate
        tempos and scores how well *all* beats sit on a half-beat grid (a comb / phase coherence search), which
        is indifferent to which of the two the tracker picked at any moment.
        Returns (bpm, time of beat 0 in seconds, median absolute residual in seconds).
        """
        t = self.beats

        def coherence(bpm: np.ndarray) -> np.ndarray:
            half = 30 / bpm
            return np.abs(np.exp(2j * np.pi * t[None, :] / half[:, None]).mean(1))

        coarse = np.arange(lo, hi, 0.05)
        best = coarse[np.argmax(coherence(coarse))]
        fine = np.arange(best - 0.1, best + 0.1, 0.001)
        bpm = float(fine[np.argmax(coherence(fine))])
        half = 30 / bpm
        phase = np.angle(np.exp(2j * np.pi * t / half).mean()) / (2 * np.pi) * half
        # Anchor beat 0 on the full-beat grid point closest to the first tracked downbeat.
        anchor = self.downbeats[0] if len(self.downbeats) else t[0]
        t0 = phase + np.round((anchor - phase) / half) * half
        residual = np.abs(t - t0 - np.round((t - t0) / half) * half)
        return bpm, float(t0), float(np.median(residual))


def track(path: str) -> Beats:
    from beat_this.inference import Audio2Beats

    if onnx_models.folder():
        from beat_this.model.postprocessor import Postprocessor

        beats, downbeats = Postprocessor(type="minimal")(*onnx_models.beat_logits(load(path, SR)))
        return Beats(np.asarray(beats), np.asarray(downbeats))
    # Beat This! doesn't support MPS for every op, CPU is fast enough (a few seconds per song).
    dev = "cuda" if device() == "cuda" else "cpu"
    audio = load(path, SR)
    with torch.no_grad():
        beats, downbeats = Audio2Beats(checkpoint_path="final0", device=dev, dbn=False)(audio, SR)
    return Beats(np.asarray(beats), np.asarray(downbeats))
