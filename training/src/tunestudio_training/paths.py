"""Where songs, data, runs and models live. Each comes from its `TST_*` variable, else `training/tst.toml`, else a
default in the git-ignored `training/.local/` (config.py has the rules, `tst status` shows the values in use):

- library_roots (TST_LIBRARY): song library roots, one folder per song ("Artist - Title") with a hand-made chart and
  its audio
- data (TST_DATA): datasets and vocal stems (`stems/<song>/vocals.flac` + `pitch.npz`)
- stem_dirs: data's stems, then the folders of TST_STEMS: more `<song>/vocals.flac` + `pitch.npz` to reuse
- runs (TST_RUNS): evaluation runs, exports and goldens
- models (TST_MODELS): checkpoints (`aligner/<name>/`, `boundary/<name>.pt`, `notefix/<name>.pkl`, `ends/<name>.pkl`,
  `game/<GAME ONNX dir>/`, the vocal separation model)
- aligner (TST_ALIGNER): the aligner the pipeline runs, `<models>/aligner/aligner-ft2` unless set
- game (TST_GAME): GAME's ONNX models, `<models>/game/GAME-1.0.3-large-onnx` unless set
- ort_providers (TST_ORT_PROVIDERS): GAME's ONNX Runtime providers, CPU unless set
- onnx (TST_ONNX only): run the learned models from their ONNX exports (the folder `tst export` writes), like Tune
  Studio does
"""

import os
from pathlib import Path

from tunestudio_training import config, recipes

TRAINING = config.TRAINING
LOCAL = config.LOCAL
SPLITS = TRAINING / "splits"
MODEL_CARDS = TRAINING / "model-cards"
# sha256 of every file of the four Hugging Face repos as shipped (`tst export --verify` compares with it).
SHIPPED = TRAINING / "shipped.sha256"
# The app's charting code: its generated tables (data/) and test fixtures (fixtures/).
CHARTING = TRAINING.parent / "apps" / "studio" / "electron" / "charting"


def library_roots() -> list[Path]:
    return config.value("paths.library")


def data() -> Path:
    return config.value("paths.data")


def stem_dirs() -> list[Path]:
    return [data() / "stems", *config.value("paths.stems")]


def runs() -> Path:
    return config.value("paths.runs")


def models() -> Path:
    return config.value("paths.models")


def aligner() -> Path:
    """The aligner the pipeline runs (a Hugging Face model dir)."""
    return config.value("models.aligner") or models() / "aligner" / recipes.SHIPPED["aligner"]


def game() -> Path:
    """GAME's ONNX models (openvpi's release, which Tune Studio downloads, unless set)."""
    return config.value("models.game") or models() / "game" / recipes.GAME


def ort_providers() -> tuple[str, ...]:
    """GAME's ONNX Runtime providers, e.g. ("CUDAExecutionProvider", "CPUExecutionProvider")."""
    return tuple(config.value("devices.onnx"))


def onnx() -> Path | None:
    value = os.environ.get("TST_ONNX")
    return Path(value).expanduser() if value else None
