"""Export the models to ONNX exactly as Tune Studio downloads them (one Hugging Face repo each, under tuneperfect/,
with the model card and license from `training/model-cards/<repo>/`), and check each export against the original.

tunestudio-aligner:
- aligner.onnx: the fine-tuned MMS aligner (the boundary head's backbone, aligner-ft2). Input `audio` [batch,
  samples] (16 kHz mono, raw, like ctc-forced-aligner feeds it); outputs `logits` [batch, frames, vocab] (CTC, before
  log_softmax) and `hidden` [batch, frames, 1024] (last hidden layer, what the boundary head reads). One 20ms frame
  per 320 samples.
- boundary.onnx: the syllable-start head (b1). Input `hidden` [1, frames, 1024] for the whole song (the aligner's
  windows joined, like boundary.hidden_states); output `probs` [1, frames], sigmoid applied.

tunestudio-note-refiners:
- notefix.onnx: the pitch corrector (nf4). Input `features` [notes, 24]; outputs `label` and `probabilities`
  [notes, 5] for the shifts -2..2 semitones.
- ends.onnx: the note-end regressor (e3). Input `features` [notes, 27]; output `variable` [notes, 1], seconds to add
  to each note's end.

fcpe-onnx and beat-this-onnx: the upstream pitch and beat models as the pipeline runs them, unchanged weights.
"""

import json
import pickle
import shutil
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from torch import nn

from tunestudio_training import paths, refiners
from tunestudio_training.pipeline import beats, boundary, pitch
from tunestudio_training.pipeline.audio import load

SR = 16000
REPOS = ("tunestudio-aligner", "tunestudio-note-refiners", "fcpe-onnx", "beat-this-onnx")


class Aligner(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, audio: torch.Tensor):
        hidden = self.model.wav2vec2(audio).last_hidden_state
        return self.model.lm_head(hidden), hidden


class Boundary(nn.Module):
    def __init__(self, head):
        super().__init__()
        self.head = head

    def forward(self, hidden: torch.Tensor):
        return torch.sigmoid(self.head(hidden))


def session(path: Path) -> ort.InferenceSession:
    return ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])


def windows(wav: np.ndarray, window: float = 30.0, context: float = 2.0) -> tuple[np.ndarray, int, int]:
    """ctc-forced-aligner's windows: 30s with 2s context each side. Returns (chunks, context frames, extension)."""
    win, ctx = int(window * SR), int(context * SR)
    if len(wav) < win:
        return wav[None], 0, 0
    ext = int(np.ceil(len(wav) / win)) * win - len(wav)
    padded = np.pad(wav, (ctx, ctx + ext))
    return (
        np.stack([padded[i : i + win + 2 * ctx] for i in range(0, len(padded) - 2 * ctx, win)]),
        ctx // 320,
        ext // 320,
    )


def joined(out: np.ndarray, ctx: int, ext: int, frames: int = 1500) -> np.ndarray:
    if ctx:
        out = out[:, ctx : ctx + frames]
    out = out.reshape(-1, out.shape[-1])
    return out[: len(out) - ext] if ext else out


def export_aligner(out: Path, head_path: Path, vocals: list[str]) -> None:
    backbone, head = boundary._load(str(head_path))
    backbone, head = backbone.cpu().float().eval(), head.cpu().eval()
    out.mkdir(parents=True, exist_ok=True)
    example = torch.zeros(2, 34 * SR)
    torch.onnx.export(
        Aligner(backbone),
        (example,),
        out / "aligner.onnx",
        input_names=["audio"],
        output_names=["logits", "hidden"],
        dynamic_axes={
            "audio": {0: "batch", 1: "samples"},
            "logits": {0: "batch", 1: "frames"},
            "hidden": {0: "batch", 1: "frames"},
        },
        opset_version=17,
        dynamo=False,
    )
    torch.onnx.export(
        Boundary(head),
        (torch.zeros(1, 500, 1024),),
        out / "boundary.onnx",
        input_names=["hidden"],
        output_names=["probs"],
        dynamic_axes={"hidden": {1: "frames"}, "probs": {1: "frames"}},
        opset_version=17,
        dynamo=False,
    )
    src = boundary.backbone_dir(str(head_path), torch.load(head_path, map_location="cpu", weights_only=False))
    for name in ("vocab.json", "tokenizer_config.json", "config.json"):
        shutil.copy(src / name, out / name)

    aligner, bnd = session(out / "aligner.onnx"), session(out / "boundary.onnx")
    for path in vocals:
        wav = load(path, SR).astype(np.float32)
        chunks, ctx, ext = windows(wav)
        logits, hidden = [], []
        for i in range(0, len(chunks), 4):
            lo, hi = aligner.run(None, {"audio": chunks[i : i + 4]})
            logits.append(lo)
            hidden.append(hi)
        logits, hidden = joined(np.concatenate(logits), ctx, ext), joined(np.concatenate(hidden), ctx, ext)
        probs = bnd.run(None, {"hidden": hidden[None]})[0][0]

        # The originals, the way the pipeline computes them.
        from ctc_forced_aligner import generate_emissions

        ref_em, _ = generate_emissions(backbone, torch.from_numpy(wav), batch_size=4)
        ref_em = ref_em[:, :-1].numpy()  # without the star column the aligner appends
        em = torch.log_softmax(torch.from_numpy(logits), -1).numpy()
        ref_probs = boundary.probabilities.__wrapped__(path, str(head_path))
        print(
            f"{Path(path).parent.name[:40]:40s} {len(wav) / SR:5.0f}s  emissions max|Δ| {np.abs(em - ref_em).max():.2e}"
            f" argmax same {np.mean(em.argmax(1) == ref_em.argmax(1)):.4%}"
            f"  probs max|Δ| {np.abs(probs - ref_probs).max():.2e}"
            f" peaks≥0.3 same {np.mean((probs >= 0.3) == (ref_probs >= 0.3)):.4%}"
        )


def export_refiners(out: Path, notefix_path: Path, ends_path: Path, data_path: Path | None) -> None:
    """Both refiners as ONNX, checked against scikit-learn on the notes dataset (`data_path`, None: unchecked)."""
    import onnx.helper
    from skl2onnx import to_onnx

    # skl2onnx 1.20 passes scikit-learn 1.9's boolean "missing values go left" flags where ONNX wants ints.
    make_attribute = onnx.helper.make_attribute
    if not getattr(make_attribute, "patched", False):

        def ints(key, value, *args, **kwargs):
            if isinstance(value, (list, tuple, np.ndarray)) and any(isinstance(v, (bool, np.bool_)) for v in value):
                value = [int(v) for v in value]
            return make_attribute(key, value, *args, **kwargs)

        ints.patched = True
        onnx.helper.make_attribute = ints

    from skl2onnx.common.data_types import FloatTensorType

    out.mkdir(parents=True, exist_ok=True)
    # The note dataset is only the check's input. The graphs depend on the models alone.
    from tunestudio_training.pipeline import ends as ends_step
    from tunestudio_training.pipeline import notefix as notefix_step

    data = np.load(data_path) if data_path else None
    nf = pickle.loads(notefix_path.read_bytes())

    onx = to_onnx(
        nf,
        initial_types=[("features", FloatTensorType([None, len(notefix_step.FEATURES)]))],
        options={id(nf): {"zipmap": False}},
        target_opset={"": 17, "ai.onnx.ml": 3},
    )
    (out / "notefix.onnx").write_bytes(onx.SerializeToString())
    en = pickle.loads(ends_path.read_bytes())
    onx = to_onnx(
        en,
        initial_types=[("features", FloatTensorType([None, len(ends_step.FEATURES)]))],
        target_opset={"": 17, "ai.onnx.ml": 3},
    )
    (out / "ends.onnx").write_bytes(onx.SerializeToString())
    (out / "notefix.json").write_text(json.dumps({"classes": [int(c) for c in nf.classes_], "threshold": 0.5}) + "\n")
    if data is None:
        print("refiners: no notes dataset, so the ONNX files aren't checked against scikit-learn (--data)")
        return

    X = data["all_X"].astype(np.float32)
    label, proba = session(out / "notefix.onnx").run(None, {"features": X})
    ref = nf.predict_proba(X)
    print(
        f"notefix  {len(X)} notes  proba max|Δ| {np.abs(proba - ref).max():.2e}"
        f"  label same {np.mean(label == nf.predict(X)):.4%}"
        f"  shift decision same {np.mean(decide(proba, nf.classes_) == decide(ref, nf.classes_)):.4%}"
    )

    F = refiners.end_rows(data)[0].astype(np.float32)
    pred = session(out / "ends.onnx").run(None, {"features": F})[0].ravel()
    ref = en.predict(F)
    print(f"ends     {len(F)} notes  max|Δ| {np.abs(pred - ref).max() * 1000:.3f}ms")


def spectrum(y: torch.Tensor, n_fft: int, hop: int, eps: float = 0.0) -> torch.Tensor:
    """Magnitude STFT [batch, bins, frames] of an already padded signal [batch, samples], as a strided convolution
    with a periodic Hann window: plain ONNX ops that every execution provider runs (unlike the STFT op)."""
    n = torch.arange(n_fft, dtype=torch.float64)
    k = torch.arange(n_fft // 2 + 1, dtype=torch.float64)[:, None]
    window = torch.hann_window(n_fft, dtype=torch.float64)
    basis = torch.cat([torch.cos(2 * torch.pi * k * n / n_fft), -torch.sin(2 * torch.pi * k * n / n_fft)]) * window
    out = nn.functional.conv1d(y[:, None], basis.float()[:, None], stride=hop)
    re, im = out.chunk(2, dim=1)
    return torch.sqrt(re * re + im * im + eps)


class Fcpe(nn.Module):
    """torchfcpe's bundled model as the pipeline runs it (pitch.track): 16 kHz audio [1, samples] -> f0 [1, frames] in
    Hz, 0 where unvoiced, one frame per 10ms (samples // 160 + 1 frames). Mel, model and local-argmax decoding
    (threshold 0.006, at most 1400 Hz) are all in the graph."""

    def __init__(self, infer):
        super().__init__()
        self.model = infer.model
        self.register_buffer("mel_basis", infer.wav2mel.mel_extractor.mel_basis.clone())
        self.register_buffer("cents", self.model.cent_table.clone())

    def forward(self, audio: torch.Tensor):
        y = nn.functional.pad(audio[:, None], (432, 432), mode="reflect")[:, 0]  # (1024 - 160) // 2 each side
        mel = torch.log(torch.clamp(torch.matmul(self.mel_basis, spectrum(y, 1024, 160, 1e-9)), min=1e-5)).transpose(
            1, 2
        )
        mel = torch.cat([mel, mel[:, -1:]], 1)  # torchfcpe repeats the last frame to get samples // 160 + 1
        y = self.model(mel)
        confident, top = torch.max(y, dim=-1, keepdim=True)
        index = torch.clamp(torch.arange(9, device=y.device) + top - 4, 0, y.shape[-1] - 1)
        weights = torch.gather(y, -1, index)
        cents = torch.sum(self.cents[index] * weights, -1) / torch.sum(weights, -1)
        f0 = torch.clamp(10.0 * torch.pow(2.0, cents / 1200.0), max=1400.0)
        return torch.where(confident[..., 0] > 0.006, f0, torch.zeros_like(f0))


class LogMel(nn.Module):
    """Beat This!'s input (LogMelSpect): 22.05 kHz audio [samples] -> log mel spectrogram [frames, 128], 50 per
    second."""

    def __init__(self, spect):
        super().__init__()
        self.register_buffer("fb", spect.spect_class.mel_scale.fb.clone())  # [bins, 128]

    def forward(self, audio: torch.Tensor):
        y = nn.functional.pad(audio[None, None], (512, 512), mode="reflect")[0]
        mag = spectrum(y, 1024, 441) / 32.0  # torchaudio's normalized="frame_length": 1 / sqrt(1024)
        return torch.log1p(1000 * torch.matmul(mag[0].T, self.fb))


class BeatThis(nn.Module):
    """Beat This! final0 on one chunk: spectrogram [1, frames, 128] -> beat and downbeat logits [1, frames]. One
    chunk at a time: the model reads its batch size with len(), which tracing turns into a constant."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, spect: torch.Tensor):
        out = self.model(spect)
        return out["beat"], out["downbeat"]


def export_fcpe(out: Path, vocals: list[str]) -> None:
    infer = pitch._fcpe().cpu()
    out.mkdir(parents=True, exist_ok=True)
    model = Fcpe(infer).eval()
    torch.onnx.export(
        model,
        (torch.zeros(1, 5 * SR),),
        out / "fcpe.onnx",
        input_names=["audio"],
        output_names=["f0"],
        dynamic_axes={"audio": {1: "samples"}, "f0": {1: "frames"}},
        opset_version=17,
        dynamo=False,
    )
    fcpe = session(out / "fcpe.onnx")
    for path in vocals:
        wav = load(path, SR).astype(np.float32)
        f0 = fcpe.run(None, {"audio": wav[None]})[0][0]
        with torch.no_grad():
            ref = (
                infer.infer(
                    torch.from_numpy(wav)[None, :, None],
                    sr=SR,
                    decoder_mode="local_argmax",
                    threshold=0.006,
                    f0_min=60,
                    f0_max=1400,
                )
                .squeeze()
                .numpy()
            )
        both = (f0 > 0) & (ref > 0)
        cents = 1200 * np.abs(np.log2(f0[both] / ref[both]))
        print(
            f"fcpe {Path(path).parent.name[:40]:40s} frames {len(f0)}/{len(ref)}"
            f"  voiced same {np.mean((f0 > 0) == (ref > 0)):.4%}"
            f"  max |Δ| {cents.max():.3f} cents"
        )


def export_beat_this(out: Path, songs: list[str]) -> None:
    from beat_this.inference import Audio2Beats

    ref = Audio2Beats(checkpoint_path="final0", device="cpu", dbn=False)
    out.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        LogMel(ref.spect).eval(),
        (torch.zeros(10 * beats.SR),),
        out / "logmel.onnx",
        input_names=["audio"],
        output_names=["spect"],
        dynamic_axes={"audio": {0: "samples"}, "spect": {0: "frames"}},
        opset_version=17,
        dynamo=False,
    )
    torch.onnx.export(
        BeatThis(ref.model).eval(),
        (torch.zeros(1, 1500, 128),),
        out / "beat_this.onnx",
        input_names=["spect"],
        output_names=["beat", "downbeat"],
        dynamic_axes={"spect": {1: "frames"}, "beat": {1: "frames"}, "downbeat": {1: "frames"}},
        opset_version=17,
        dynamo=False,
    )
    for frames in (1500, 700, 37):
        x = torch.randn(1, frames, 128)
        with torch.inference_mode():
            want = ref.model(x)
        got = session(out / "beat_this.onnx").run(None, {"spect": x.numpy()})
        print(
            f"beat_this {frames} random frames  max|Δ| "
            f"{max(np.abs(g - want[k].numpy()).max() for g, k in zip(got, ('beat', 'downbeat'))):.2e}"
        )
    logmel, model = session(out / "logmel.onnx"), session(out / "beat_this.onnx")

    class Onnx(nn.Module):  # the ONNX model inside Beat This!'s own chunking, so only the model differs
        def forward(self, spect):
            beat, downbeat = model.run(None, {"spect": spect.numpy()})
            return {"beat": torch.from_numpy(beat), "downbeat": torch.from_numpy(downbeat)}

    from beat_this.inference import split_predict_aggregate

    for path in songs:
        audio = load(path, beats.SR).astype(np.float32)
        spect = logmel.run(None, {"audio": audio})[0]
        with torch.inference_mode():
            ref_spect = ref.spect(torch.from_numpy(audio)).numpy()
            pred = split_predict_aggregate(
                spect=torch.from_numpy(spect), chunk_size=1500, overlap_mode="keep_first", border_size=6, model=Onnx()
            )
        found = ref.frames2beats(pred["beat"].float(), pred["downbeat"].float())
        expected = ref(audio, beats.SR)
        same = [len(a) == len(b) and np.allclose(a, b) for a, b in zip(found, expected)]
        print(
            f"beat_this {Path(path).name[:40]:40s} spect max|Δ| {np.abs(spect - ref_spect).max():.2e}"
            f"  beats {len(found[0])}/{len(expected[0])} downbeats {len(found[1])}/{len(expected[1])}"
            f" identical {all(same)}"
        )


def decide(proba: np.ndarray, classes: np.ndarray) -> np.ndarray:
    k = proba.argmax(1)
    return np.where(proba[np.arange(len(k)), k] >= 0.5, classes[k], 0)


def export(repo: str, out: Path, vocals: list[str], models: dict[str, Path], data: Path | None) -> None:
    """Write one repo's files into `out` (its model card and license included). `vocals`: songs to check the aligner,
    FCPE and Beat This! exports on; `data`: the note dataset the refiners are checked on."""
    if repo == "tunestudio-aligner":
        export_aligner(out, models["boundary"], vocals)
    elif repo == "tunestudio-note-refiners":
        export_refiners(out, models["notefix"], models["ends"], data)
    elif repo == "fcpe-onnx":
        export_fcpe(out, vocals)
    elif repo == "beat-this-onnx":
        export_beat_this(out, vocals)
    else:
        raise SystemExit(f"unknown repo {repo!r}, one of {', '.join(REPOS)}")
    for f in (paths.MODEL_CARDS / repo).iterdir():
        shutil.copy(f, out / f.name)
