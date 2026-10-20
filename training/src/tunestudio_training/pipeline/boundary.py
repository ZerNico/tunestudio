"""Syllable-start detector: a small head on the (singing fine-tuned) MMS aligner's hidden states that outputs, every
20ms, the probability that a syllable starts there. Trained on the hand-made charts' syllable starts
(`tst train boundary`). The CTC aligner only learns *which* characters are sung; this learns *where* charters put
syllable starts, and `assign` moves the aligner's syllable starts to nearby peaks.
"""

from functools import cache
from pathlib import Path

import numpy as np
import torch
from torch import nn

from . import onnx_models
from .audio import load

FRAME = 0.02  # wav2vec2 / MMS output stride
SR = 16000
_DEV = "cuda" if torch.cuda.is_available() else "cpu"  # CPU elsewhere: fast enough, and MPS numerics differ


class Head(nn.Module):
    def __init__(self, dim: int = 1024, hidden: int = 192):
        super().__init__()
        self.proj = nn.Linear(dim, hidden)
        self.rnn = nn.GRU(hidden, hidden, batch_first=True, bidirectional=True)
        self.out = nn.Linear(2 * hidden, 1)

    def forward(self, h: torch.Tensor) -> torch.Tensor:  # [B, T, dim] -> logits [B, T]
        x, _ = self.rnn(torch.relu(self.proj(h)))
        return self.out(x).squeeze(-1)


def hidden_states(backbone, wav: torch.Tensor, window: float = 30.0, context: float = 2.0) -> torch.Tensor:
    """Last hidden layer for a whole song ([T, dim]), in windows with context like ctc-forced-aligner's emissions."""
    win, ctx = int(window * SR), int(context * SR)
    ratio = backbone.config.inputs_to_logits_ratio
    if len(wav) <= win:
        with torch.inference_mode():
            return backbone.wav2vec2(wav[None]).last_hidden_state[0]
    ext = int(np.ceil(len(wav) / win)) * win - len(wav)
    padded = torch.nn.functional.pad(wav, (ctx, ctx + ext))
    chunks = padded.unfold(0, win + 2 * ctx, win)
    out = []
    with torch.inference_mode():
        for i in range(0, len(chunks), 4):
            h = backbone.wav2vec2(chunks[i : i + 4]).last_hidden_state
            out.append(h[:, ctx // ratio : ctx // ratio + win // ratio])
    h = torch.cat(out).flatten(0, 1)
    return h[: len(h) - ext // ratio] if ext else h


def backbone_dir(head_path: str, ckpt: dict) -> Path:
    """The aligner the head was trained on, by name: `aligner/<name>` next to the head's `boundary/` folder."""
    return Path(head_path).resolve().parents[1] / "aligner" / ckpt["backbone"]


@cache
def _load(head_path: str):
    from transformers import Wav2Vec2ForCTC

    ckpt = torch.load(head_path, map_location="cpu", weights_only=False)
    backbone = Wav2Vec2ForCTC.from_pretrained(backbone_dir(head_path, ckpt)).eval()
    head = Head(ckpt["dim"], ckpt["hidden"]).eval()
    head.load_state_dict(ckpt["state"])
    return backbone.to(_DEV), head.to(_DEV)


@cache
def probabilities(vocals_path: str, head_path: str) -> np.ndarray:
    """Syllable-start probability per 20ms frame of a vocal stem."""
    if onnx_models.folder():
        return onnx_models.boundary_probabilities(vocals_path)
    backbone, head = _load(head_path)
    # The backbone's device, not _DEV: `tst export` moves the cached models to the CPU.
    wav = torch.from_numpy(load(vocals_path, SR).copy()).to(next(backbone.parameters()).device)
    with torch.inference_mode():
        return torch.sigmoid(head(hidden_states(backbone, wav)[None]))[0].cpu().numpy()


def assign(
    starts: list[float], probs: np.ndarray, radius: float = 0.2, min_prob: float = 0.3, cost: float = 1.0
) -> list[float]:
    """Move each start to a peak (local maximum >= min_prob) within ±radius or leave it, one-to-one: no two starts
    take the same peak and the order is kept. Maximises sum(peak prob - cost * shift / radius) over
    all starts (dynamic programming over the few candidates per start), so a start only jumps far for a clearly
    better peak and neighbours don't collapse onto one peak."""
    if not starts:
        return []
    peaks = np.where((probs[1:-1] >= min_prob) & (probs[1:-1] >= probs[:-2]) & (probs[1:-1] > probs[2:]))[0] + 1
    times = peaks * FRAME
    # candidates per start: (time, score, peak id); id -1 = stay where it is
    cands = []
    for t in starts:
        c = [(t, 0.0, -1)]
        for k in np.where(np.abs(times - t) <= radius)[0]:
            c.append((float(times[k]), float(probs[peaks[k]]) - cost * abs(times[k] - t) / radius, int(k)))
        cands.append(c)
    best = [[(sc, -1) for _, sc, _ in cands[0]]]  # per start, per candidate: (total score, back pointer)
    for i in range(1, len(starts)):
        row = []
        for t, sc, k in cands[i]:
            options = [
                (best[i - 1][j][0] + sc, j)
                for j, (pt, _, pk) in enumerate(cands[i - 1])
                if pt + FRAME <= t and (k < 0 or pk < k)
            ]
            row.append(max(options) if options else (-np.inf, 0))
        best.append(row)
    j = int(np.argmax([b[0] for b in best[-1]]))
    if not np.isfinite(best[-1][j][0]):
        return list(starts)
    out = []
    for i in range(len(starts) - 1, -1, -1):
        out.append(cands[i][j][0])
        j = best[i][j][1]
    return out[::-1]
