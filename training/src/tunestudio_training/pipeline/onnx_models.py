"""The models from the ONNX exports Tune Studio downloads (`tst export`, hosted on Hugging Face under tuneperfect/),
instead of PyTorch and scikit-learn. On when TST_ONNX points at the export folder (tunestudio-aligner/,
tunestudio-note-refiners/, fcpe-onnx/, beat-this-onnx/), so a run measures what the app gets: pitch, beats, aligner
emissions, the boundary head, notefix and ends all take this path. The goldens are recorded on it.
"""

from functools import cache
from pathlib import Path

import numpy as np

from tunestudio_training import paths

from .audio import load

SR = 16000


def folder() -> Path | None:
    return paths.onnx()


@cache
def session(relative: str):
    import onnxruntime as ort

    return ort.InferenceSession(str(folder() / relative), providers=["CPUExecutionProvider"])


def f0(audio: np.ndarray) -> np.ndarray:
    """FCPE pitch in Hz every 10ms (0 = unvoiced) of 16 kHz audio, like pitch.track's torchfcpe call."""
    return session("fcpe-onnx/fcpe.onnx").run(None, {"audio": audio.astype(np.float32)[None]})[0][0]


def beat_logits(audio: np.ndarray):
    """Beat This! frame logits of 22.05 kHz audio, chunked and joined like beat_this.inference.Spect2Frames."""
    import torch
    from beat_this.inference import split_predict_aggregate

    spect = session("beat-this-onnx/logmel.onnx").run(None, {"audio": audio.astype(np.float32)})[0]
    model = session("beat-this-onnx/beat_this.onnx")

    def predict(chunk):
        beat, downbeat = model.run(None, {"spect": chunk.numpy()})
        return {"beat": torch.from_numpy(beat), "downbeat": torch.from_numpy(downbeat)}

    with torch.inference_mode():
        pred = split_predict_aggregate(
            spect=torch.from_numpy(spect), chunk_size=1500, overlap_mode="keep_first", border_size=6, model=predict
        )
    return pred["beat"].float(), pred["downbeat"].float()


def _windows(wav: np.ndarray, window: float = 30.0, context: float = 2.0):
    """ctc-forced-aligner's generate_emissions windows: (chunks, context frames, window frames, extension frames)."""
    win, ctx = int(window * SR), int(context * SR)
    if len(wav) < win:
        return wav[None], 0, None, 0
    ext = int(np.ceil(len(wav) / win)) * win - len(wav)
    padded = np.pad(wav, (ctx, ctx + ext))
    chunks = np.stack([padded[i : i + win + 2 * ctx] for i in range(0, len(padded) - 2 * ctx, win)])
    return chunks, ctx // 320, win // 320, ext // 320


def _join(out: np.ndarray, ctx: int, frames: int | None, ext: int) -> np.ndarray:
    if frames is not None:
        out = out[:, ctx : ctx + frames]
    out = out.reshape(-1, out.shape[-1])
    # Like generate_emissions' emissions[: -(extension // ratio)], including its [:0] when the extension is under one
    # frame.
    return out[:-ext] if ext else out


@cache
def _aligner_outputs(vocals_path: str) -> tuple[np.ndarray, np.ndarray]:
    wav = load(vocals_path, SR).astype(np.float32)
    chunks, ctx, frames, ext = _windows(wav)
    model = session("tunestudio-aligner/aligner.onnx")
    logits, hidden = [], []
    for chunk in chunks:  # one window at a time: the same outputs as batches, less memory
        lo, hi = model.run(None, {"audio": chunk[None]})
        logits.append(lo)
        hidden.append(hi)
    return _join(np.concatenate(logits), ctx, frames, ext), _join(np.concatenate(hidden), ctx, frames, ext)


def emissions(vocals_path: str):
    """CTC log-probs plus the zero <star> column, like align.emissions (generate_emissions)."""
    import torch

    logits = torch.from_numpy(_aligner_outputs(vocals_path)[0])
    em = torch.log_softmax(logits, dim=-1)
    return torch.cat([em, torch.zeros(em.size(0), 1)], dim=1), 320 * 1000 / SR


def boundary_probabilities(vocals_path: str) -> np.ndarray:
    hidden = _aligner_outputs(vocals_path)[1]
    return session("tunestudio-aligner/boundary.onnx").run(None, {"hidden": hidden[None]})[0][0]


class Notefix:
    """notefix.onnx with the scikit-learn classifier's interface (predict_proba, classes_)."""

    classes_ = np.array([-2, -1, 0, 1, 2])

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        return session("tunestudio-note-refiners/notefix.onnx").run(
            ["probabilities"], {"features": np.asarray(X, np.float32)}
        )[0]


class Ends:
    """ends.onnx with the scikit-learn regressor's interface (predict)."""

    def predict(self, X: np.ndarray) -> np.ndarray:
        return (
            session("tunestudio-note-refiners/ends.onnx").run(None, {"features": np.asarray(X, np.float32)})[0].ravel()
        )
