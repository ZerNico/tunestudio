"""Audio loading via ffmpeg, so every container (opus, m4a, webm, ...) works the same on every OS."""

import subprocess

import numpy as np


def load(path: str, sr: int = 44100, mono: bool = True) -> np.ndarray:
    """Decode any file ffmpeg understands into float32 samples, shape (n,) when mono or (n, channels)."""
    channels = 1 if mono else 2
    cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", str(channels), "-ar", str(sr), "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    audio = np.frombuffer(raw, dtype=np.float32)
    return audio if mono else audio.reshape(-1, channels)
