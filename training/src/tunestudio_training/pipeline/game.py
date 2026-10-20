"""Note extraction with GAME (openvpi, Generative Adaptive MIDI Extractor), run through ONNX Runtime with the
released ONNX models, the same way the app would run it.

Pipeline per chunk (see third_party/GAME/ONNX.md): encoder(waveform) -> x_seg, x_est; known region durations ->
dur2bd -> known boundaries; segmenter D3PM loop (boundaries fed back as prev_boundaries) -> boundaries;
bd2dur -> note durations; estimator -> presence + float MIDI pitch per note.
Known boundaries are kept, so passing syllable boundaries makes GAME only add melisma splits inside syllables.

The segmenter samples (each D3PM step drops random boundaries, a RandomUniformLike op in the ONNX graph). That op
is replaced by an input fed from a seeded generator per call: the same chunk always gives the same notes, whatever
ran before and on any execution provider.
"""

import json
from dataclasses import dataclass
from functools import cache
from pathlib import Path

import numpy as np

from tunestudio_training import paths

NOISE = "uniform_noise"


def _segmenter_with_noise_input(path: Path) -> bytes:
    """The segmenter with its RandomUniformLike op replaced by an input (NOISE, same shape as the boundaries), so
    the caller supplies the random numbers: seeded, reproducible, the same on every execution provider."""
    import onnx

    m = onnx.load(str(path))
    rnd = next(n for n in m.graph.node if n.op_type == "RandomUniformLike")
    for n in m.graph.node:
        for i, name in enumerate(n.input):
            if name == rnd.output[0]:
                n.input[i] = NOISE
    m.graph.node.remove(rnd)
    m.graph.input.append(onnx.helper.make_tensor_value_info(NOISE, onnx.TensorProto.FLOAT, ["B", "T"]))
    return m.SerializeToString()


@dataclass
class GameNote:
    start: float  # seconds, relative to the chunk
    end: float
    voiced: bool
    midi: float


class Game:
    def __init__(self, model_dir: Path, providers: tuple[str, ...] = ("CPUExecutionProvider",)):
        import onnxruntime as ort

        self.config = json.loads((model_dir / "config.json").read_text())
        opts = ort.SessionOptions()
        self.s = {
            name: ort.InferenceSession(
                _segmenter_with_noise_input(model_dir / f"{name}.onnx")
                if name == "segmenter"
                else str(model_dir / f"{name}.onnx"),
                opts,
                providers=list(providers),
            )
            for name in ("encoder", "segmenter", "estimator", "dur2bd", "bd2dur")
        }

    @property
    def sr(self) -> int:
        return self.config["samplerate"]

    def language_id(self, language: str) -> int:
        """ID of a language name ("German") or code ("de"); 0 (universal) if the model doesn't know it."""
        codes = {
            "english": "en",
            "german": "de",
            "japanese": "ja",
            "chinese": "zh",
            "cantonese": "yue",
            "spanish": "es",
            "dutch": "nl",
            "french": "fr",
            "italian": "it",
            "finnish": "fi",
            "portuguese": "pt",
            "romanian": "ro",
        }
        name = language.lower().split(" (")[0]
        return (self.config.get("languages") or {}).get(codes.get(name, name), 0)

    def _segment(self, x_seg, known_bd, mask_t, language, boundary_threshold, radius, nsteps, t0) -> np.ndarray:
        """One D3PM sample of the boundaries, with noise seeded the same way for every chunk."""
        rng = np.random.default_rng(0)
        bd = known_bd
        step = (1 - t0) / nsteps
        for i in range(nsteps):
            (bd,) = self.s["segmenter"].run(
                None,
                {
                    "x_seg": x_seg,
                    "language": np.array([language], np.int64),
                    "known_boundaries": known_bd,
                    "prev_boundaries": bd,
                    "t": np.array([t0 + i * step], np.float32),
                    "maskT": mask_t,
                    "threshold": np.array(boundary_threshold, np.float32),
                    "radius": np.array(radius, np.int64),
                    NOISE: rng.random(mask_t.shape, dtype=np.float32),
                },
            )
        return bd

    def extract(
        self,
        waveform: np.ndarray,
        known: list[float] | None = None,
        language: int = 0,
        boundary_threshold: float = 0.2,
        radius: int = 2,
        presence_threshold: float = 0.2,
        nsteps: int = 8,
        t0: float = 0.0,
    ) -> list[GameNote]:
        """`known`: durations (seconds) of regions whose boundaries must be kept, summing to the chunk length."""
        duration = len(waveform) / self.sr
        wav = waveform.astype(np.float32)[None, :]
        x_seg, x_est, mask_t = self.s["encoder"].run(
            None, {"waveform": wav, "duration": np.array([duration], np.float32)}
        )
        durations = np.array([known if known else [duration]], np.float32)
        if durations.shape[1] > 1:
            (known_bd,) = self.s["dur2bd"].run(None, {"durations": durations, "maskT": mask_t})
        else:  # one region has no inner boundaries; the CUDA provider can't reduce over the empty axis
            known_bd = np.zeros_like(mask_t)
        known_bd = known_bd & mask_t
        bd = self._segment(x_seg, known_bd, mask_t, language, boundary_threshold, radius, nsteps, t0)
        note_dur, mask_n = self.s["bd2dur"].run(None, {"boundaries": bd, "maskT": mask_t})
        presence, scores = self.s["estimator"].run(
            None,
            {
                "x_est": x_est,
                "boundaries": bd,
                "maskT": mask_t,
                "maskN": mask_n,
                "threshold": np.array(presence_threshold, np.float32),
            },
        )
        out, t = [], 0.0
        for d, m, p, s in zip(note_dur[0], mask_n[0], presence[0], scores[0]):
            if not m:
                break
            out.append(GameNote(t, t + float(d), bool(p), float(s)))
            t += float(d)
        return out


def model_dir(override: str | None = None) -> Path:
    """GAME's ONNX models: `override`, else TST_GAME (or models.game in tst.toml), else
    `<TST_MODELS>/game/GAME-1.0.3-large-onnx` (openvpi's release, which Tune Studio downloads)."""
    return Path(override) if override else paths.game()


@cache
def model(override: str | None = None) -> Game:
    """GAME from `model_dir`. TST_ORT_PROVIDERS (comma-separated, e.g. "CUDAExecutionProvider,CPUExecutionProvider",
    or devices.onnx in tst.toml) picks the ONNX Runtime providers; default CPU."""
    return Game(model_dir(override), paths.ort_providers())
