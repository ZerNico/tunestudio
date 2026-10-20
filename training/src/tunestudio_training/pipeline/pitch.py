"""Frame-wise f0 tracking of an isolated vocal stem."""

from dataclasses import dataclass
from functools import cache

import numpy as np
import torch

from . import onnx_models
from .audio import load

SR = 16000
HOP_SEC = 0.01


@dataclass
class PitchTrack:
    times: np.ndarray  # seconds, one per frame
    midi: np.ndarray  # fractional MIDI note number, NaN when unvoiced
    rms: np.ndarray | None = None  # dB per frame, same length

    def slice(self, start: float, end: float) -> np.ndarray:
        i, j = np.searchsorted(self.times, [start, end])
        return self.midi[i:j]


def loudness(audio: np.ndarray, n_frames: int, sr: int = SR) -> np.ndarray:
    """RMS in dB per 10ms frame (25ms window), aligned with the pitch frames."""
    hop, win = int(HOP_SEC * sr), int(0.025 * sr)
    padded = np.pad(audio, (win // 2, win))
    idx = np.arange(n_frames)[:, None] * hop + np.arange(win)[None, :]
    idx = np.minimum(idx, len(padded) - 1)
    return 10 * np.log10(np.mean(padded[idx] ** 2, axis=1) + 1e-10)


def device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


@cache
def _fcpe():
    from torchfcpe import spawn_bundled_infer_model

    return spawn_bundled_infer_model(device=device())


def track(path: str) -> PitchTrack:
    audio = load(path, SR)
    if onnx_models.folder():
        f0 = onnx_models.f0(audio)
    else:
        model = _fcpe()
        wav = torch.from_numpy(audio.copy()).float().to(model.device if hasattr(model, "device") else device())
        with torch.no_grad():
            f0 = model.infer(
                wav[None, :, None], sr=SR, decoder_mode="local_argmax", threshold=0.006, f0_min=60, f0_max=1400
            )
        f0 = f0.squeeze().cpu().numpy()
    midi = np.full_like(f0, np.nan)
    voiced = f0 > 0
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / 440)
    return PitchTrack(np.arange(len(f0)) * HOP_SEC, midi, loudness(audio, len(f0)))
