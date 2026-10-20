"""The device `tst train` trains the aligner and the boundary head on, its autocast, and seeding.

"auto" is CUDA when there is one, else the CPU: what the shipped models were trained with. Apple Silicon's GPU (MPS)
runs everything the training needs (the GRU, CTC loss and their gradients), but only when asked for with
`--device mps` (or TST_DEVICE / devices.train) until an MPS-trained model has been judged end to end like any other
(README, "GPU and Apple Silicon"). Inference doesn't use this: the pipeline keeps its own CUDA-or-CPU choice, so
evaluation runs stay comparable.
"""

import torch

from tunestudio_training import config


def available() -> dict[str, bool]:
    return {"cuda": torch.cuda.is_available(), "mps": torch.backends.mps.is_available(), "cpu": True}


def training_device(requested: str | None = None) -> str:
    """--device, else TST_DEVICE / devices.train, else "auto"."""
    name = requested or config.value("devices.train")
    if name not in config.DEVICES:
        raise SystemExit(f"unknown device {name!r}, one of {', '.join(config.DEVICES)}")
    have = available()
    if name == "auto":
        return "cuda" if have["cuda"] else "cpu"
    if not have[name]:
        hint = {
            "cuda": "this torch has no CUDA build or sees no GPU (tst doctor says which)",
            "mps": "MPS needs an Apple Silicon Mac",
        }[name]
        raise SystemExit(f"--device {name}: not available here ({hint})")
    return name


def autocast(device: str):
    """bf16 on CUDA, where the shipped models were trained, plain float32 everywhere else (MPS included)."""
    return torch.autocast("cpu" if device == "mps" else device, dtype=torch.bfloat16, enabled=device == "cuda")


def seed(n: int) -> None:
    """Seed torch (CPU, CUDA and MPS): the boundary head's initial weights, and dropout if a model had any (MMS has
    none). Batch order has its own seeded generator in the training loops."""
    torch.manual_seed(n)
    if torch.backends.mps.is_available():
        torch.mps.manual_seed(n)


def empty_cache(device: str) -> None:
    """Give MPS memory back after a validation pass: variable-length batches fragment its allocator."""
    if device == "mps":
        torch.mps.empty_cache()


# Memory the aligner's training needs (MMS-300m, float32), measured on a 24 GB M5 Pro with gradient checkpointing:
# weights, gradients and AdamW's two moments, plus activations per second of audio in a micro-batch, plus headroom.
TRAIN_BASE_GB, TRAIN_PER_SECOND_GB, HEADROOM_GB = 5.0, 0.05, 1.5
MICRO_SECONDS = (60.0, 30.0, 20.0, 15.0)


def available_gb() -> float | None:
    """Memory free for a new job now: on macOS free + inactive + speculative + purgeable pages (what vm_stat calls
    reclaimable without swapping), elsewhere None (unknown)."""
    import platform
    import re
    import subprocess

    if platform.system() != "Darwin":
        return None
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    page = int(re.search(r"page size of (\d+)", out).group(1))
    pages = {m.group(1): int(m.group(2)) for m in re.finditer(r"Pages (\w+):\s+(\d+)", out)}
    return sum(pages.get(k, 0) for k in ("free", "inactive", "speculative", "purgeable")) * page / 2**30


def memory_plan(device: str, batch_seconds: float, micro_seconds: float | None = None) -> dict:
    """How a batch of `batch_seconds` of audio fits in memory, without changing the training: the batch's gradients
    are the sum of its micro-batches' (aligner._batch_loss), so only speed and memory differ.

    - CUDA: one pass, no checkpointing (what the shipped models were trained with).
    - MPS, and the CPU of a Mac under 40 GB: gradient checkpointing, and micro-batches of the longest of 60, 30, 20 and
      15 s that fit in the memory free now (other apps count: a Mac with lots in swap gets small micro-batches).
    - `micro_seconds` (--micro-batch-seconds) decides instead.
    Returns {"micro_seconds": None for the whole batch, "checkpointing", "free_gb"}."""
    if device == "cuda":
        return {"micro_seconds": micro_seconds, "checkpointing": False, "free_gb": None}
    total = memory_gb()
    if total is None or (device == "cpu" and total >= 40):
        return {"micro_seconds": micro_seconds, "checkpointing": False, "free_gb": None}
    free = available_gb()
    if device == "mps":
        cap = torch.mps.recommended_max_memory() / 2**30 - torch.mps.driver_allocated_memory() / 2**30
        free = cap if free is None else min(free, cap)
    if micro_seconds is None:
        fits = [
            s for s in (batch_seconds, *MICRO_SECONDS)
            if s <= batch_seconds and free is not None and TRAIN_BASE_GB + TRAIN_PER_SECOND_GB * s + HEADROOM_GB <= free
        ]  # fmt: skip
        micro_seconds = fits[0] if fits else MICRO_SECONDS[-1]
    return {
        "micro_seconds": micro_seconds if micro_seconds < batch_seconds else None,
        "checkpointing": True,
        "free_gb": None if free is None else round(free, 1),
    }


def in_use(device: str) -> str:
    """ ", 8.1 GB on MPS" for the training lines: MPS memory is the Mac's, shared with every other app."""
    return f", {torch.mps.driver_allocated_memory() / 2**30:.1f} GB on MPS" if device == "mps" else ""


def memory_gb() -> float | None:
    """The Mac's unified memory (what MPS can use), None elsewhere."""
    import platform
    import subprocess

    if platform.system() != "Darwin":
        return None
    try:
        out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, check=True).stdout
        return int(out) / 2**30
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None
