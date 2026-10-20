"""The aligner's 30 s windows exist three times (export.py, onnx_models.py, boundary.py) and must agree: the ONNX
exports were checked against the originals through them. Pinned here instead of merged, so the exports stay byte for
byte the same."""

from types import SimpleNamespace

import numpy as np
import pytest
import torch

from tunestudio_training import export
from tunestudio_training.pipeline import boundary, onnx_models

RATIO = 320


def fake_hidden(x: np.ndarray) -> np.ndarray:
    """A 'model' with 20 ms frames: [batch, samples] -> [batch, samples // 320, 2] (each frame's mean and sum)."""
    n = x.shape[-1] // RATIO
    frames = x[..., : n * RATIO].reshape(x.shape[0], n, RATIO)
    return np.stack([frames.mean(-1), frames.sum(-1)], -1)


class FakeBackbone:
    config = SimpleNamespace(inputs_to_logits_ratio=RATIO)

    def wav2vec2(self, x: torch.Tensor):
        return SimpleNamespace(last_hidden_state=torch.from_numpy(fake_hidden(x.numpy())))


@pytest.mark.parametrize("seconds", [5.0, 29.99, 30.0, 30.5, 60.0, 61.3, 95.0, 120.0])
def test_window_code_agrees(seconds):
    rng = np.random.default_rng(0)
    wav = rng.standard_normal(int(seconds * 16000)).astype(np.float32)
    chunks, ctx, ext = export.windows(wav)
    a = export.joined(fake_hidden(chunks), ctx, ext)
    chunks, ctx, frames, ext = onnx_models._windows(wav)
    b = onnx_models._join(fake_hidden(chunks), ctx, frames, ext)
    c = boundary.hidden_states(FakeBackbone(), torch.from_numpy(wav)).numpy()
    np.testing.assert_array_equal(a, b)
    np.testing.assert_allclose(a, c, rtol=1e-6)
    assert abs(len(a) - len(wav) // RATIO) <= 1
