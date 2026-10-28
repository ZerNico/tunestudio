"""The shipped models' recipes: the hyperparameters they were trained with and their checkpoint names. One place, so
the command-line defaults, its help, the pipeline's defaults and the README can't drift apart. Light on purpose (no
torch), so `tst --help` stays fast.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class AlignerRecipe:
    """MMS fine-tuned on the line clips: AdamW with a cosine schedule after a short warmup, the feature encoder
    frozen, the checkpoint with the best validation CTC loss kept (ft2: step 4000 of 6000)."""

    base: str = "MahmoudAshraf/mms-300m-1130-forced-aligner"
    steps: int = 6000
    lr: float = 6e-5
    batch_seconds: float = 120  # padded audio per batch
    validate_every: int = 500


@dataclass(frozen=True)
class BoundaryRecipe:
    """The syllable-start head over the frozen aligner: OneCycle at lr, batches of `batch` clips."""

    steps: int = 4000
    lr: float = 1e-3
    batch: int = 12
    hidden: int = 192
    evaluate_every: int = 1000


ALIGNER = AlignerRecipe()
BOUNDARY = BoundaryRecipe()
# The checkpoints Tune Studio ships (the pipeline's defaults). `tst train` won't overwrite them without --force.
SHIPPED = {"aligner": "aligner-ft2", "boundary": "b1", "notefix": "nf4", "ends": "e3", "golden": "g1"}
# openvpi's GAME release, unzipped under <models>/game/ (not retrained here).
GAME = "GAME-1.0.3-large-onnx"
