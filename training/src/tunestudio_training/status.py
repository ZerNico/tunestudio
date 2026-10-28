"""`tst status`: what's here (library, stems, datasets, checkpoints, runs, exports, device) and the next step for each
model. `tst doctor`: whether this machine can run tst (config, ffmpeg, torch and its devices, ONNX Runtime, GAME, the
separation model, the MMS base model, free space, nothing local tracked by git).
"""

import json
import shutil
import subprocess
from pathlib import Path

from tunestudio_training import chain, config, paths, recipes

SEPARATION_MODEL = "vocals_mel_band_roformer.ckpt"  # pipeline/separate.py's MODEL, without importing torch
SPLIT_NAMES = ("train", "dev", "test", "sel")


def _n(x: int) -> str:
    return f"{x:,}"


def _row(label: str, text: str) -> str:
    return f"{label:<9} {text}"


def _songs(split: str) -> list[str]:
    f = paths.SPLITS / f"{split}.txt"
    return [s for s in f.read_text(encoding="utf8").splitlines() if s] if f.exists() else []


def _has_stems(song: str, dirs: list[Path]) -> bool:
    return any((d / song / "vocals.flac").exists() and (d / song / "pitch.npz").exists() for d in dirs)


def config_row() -> str:
    file = config.path()
    sources = {}
    for s in config.SETTINGS:
        _, source = config.lookup(s.key)
        if source != "default":
            sources.setdefault(source, []).append(s.key.split(".")[1])
    where = ", ".join(f"{', '.join(keys)} from {source}" for source, keys in sources.items()) or "all defaults"
    state = "" if file.exists() else " (none: tst init writes it)"
    return _row("config", f"{file}{state} ({where})")


def library_row() -> str:
    roots = paths.library_roots()
    found = [r for r in roots if r.is_dir()]
    if not found:
        return _row("library", f"missing: {', '.join(map(str, roots))} (tst init --library DIR, or set TST_LIBRARY)")
    names = {p.name for r in found for p in r.iterdir() if p.is_dir()}
    manifest = json.loads((paths.SPLITS / "manifest.json").read_text(encoding="utf8"))["songs"]
    lang = {s for f in paths.SPLITS.glob("lang-*.txt") for s in _songs(f.stem)}
    new = len(names - set(manifest) - lang)
    extra = f", {_n(new)} folders not in the splits (tst splits add)" if new else ""
    return _row("library", f"{len(found)} of {len(roots)} roots, {_n(len(names))} songs{extra}")


def stems_row() -> str:
    dirs = paths.stem_dirs()
    parts = []
    for split in SPLIT_NAMES:
        songs = _songs(split)
        parts.append(f"{split} {_n(sum(_has_stems(s, dirs) for s in songs))}/{_n(len(songs))}")
    lang = [s for f in sorted(paths.SPLITS.glob("lang-*.txt")) for s in _songs(f.stem)]
    parts.append(f"lang-* {_n(sum(_has_stems(s, dirs) for s in lang))}/{_n(len(lang))}")
    return _row("stems", "  ".join(parts))


def _date(p: Path) -> str:
    import datetime

    return datetime.date.fromtimestamp(p.stat().st_mtime).isoformat()


def datasets_row() -> str:
    parts = []
    clips = chain.STEPS["clips"]
    if clips.present():
        train = chain.clips_dir() / "train"
        songs = json.loads((train / "songs.json").read_text(encoding="utf8"))["songs"]
        stats_file = chain.clips_dir() / "stats.json"
        hours = json.loads(stats_file.read_text()).get("train", {}).get("hours", "?") if stats_file.exists() else "?"
        n = sum(1 for line in (train / "index.txt").read_text().splitlines() if line)
        state = clips.state()
        text = f"clips: {_n(len(songs))} train songs, {_n(n)} clips, {hours} h ({_date(train / 'index.txt')})"
        parts.append(text + ("" if state == "ok" else f" [{state}]"))
    else:
        parts.append("clips missing")
    for name in ("targets", "boundaries"):
        parts.append(f"{name} {chain.STEPS[name].state()}")
    notes = chain.STEPS["notes"]
    if notes.present():
        import numpy as np

        with np.load(chain.notes_path()) as d:
            parts.append(
                f"notes: {_n(len(d['songs']))} songs" + ("" if notes.state() == "ok" else f" [{notes.state()}]")
            )
    else:
        parts.append("notes missing")
    return _row("datasets", "   ".join(parts))


def _checkpoints(model: str) -> list[str]:
    folder = paths.models() / model
    if not folder.is_dir():
        return []
    if model == "aligner":
        return sorted(p.name for p in folder.iterdir() if (p / "config.json").exists())
    suffix = ".pt" if model == "boundary" else ".pkl"
    return sorted(p.stem for p in folder.glob(f"*{suffix}"))


def _backbone(head: Path) -> str | None:
    try:
        import torch

        return torch.load(head, map_location="cpu", weights_only=False).get("backbone")
    except Exception:  # noqa: BLE001
        return None


def models_row() -> str:
    pipeline_aligner = paths.aligner()
    parts = []
    for model in ("aligner", "boundary", "notefix", "ends", "golden"):
        for name in _checkpoints(model):
            notes = []
            if name == recipes.SHIPPED[model]:
                notes.append("shipped")
            if model == "aligner" and chain.checkpoint("aligner", name).resolve() == pipeline_aligner.resolve():
                notes.append("pipeline")
            if model == "boundary":
                backbone = _backbone(chain.checkpoint("boundary", name))
                if backbone:
                    notes.append(f"backbone {backbone}")
            parts.append(name + (f" ({', '.join(notes)})" if notes else ""))
    if not (pipeline_aligner / "config.json").exists():
        parts.append(f"aligner for the pipeline missing ({pipeline_aligner})")
    parts.append("GAME " + ("ok" if (paths.game() / "config.json").exists() else f"missing ({paths.game()})"))
    sep = (paths.models() / SEPARATION_MODEL).exists()
    parts.append("separation model " + ("ok" if sep else "not downloaded yet (tst stems fetches it)"))
    return _row("models", "  ".join(parts) if parts else "none")


def runs_row() -> str:
    root = paths.runs() / "eval"
    if not root.is_dir():
        return _row("runs", "none")
    parts = []
    for split_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        total = len(_songs(split_dir.name))
        runs = []
        for run in sorted(p for p in split_dir.iterdir() if p.is_dir()):
            scored = sum(1 for _ in run.glob("*/scores.json"))
            runs.append(f"{run.name} {_n(scored)}/{_n(total)}" if total else f"{run.name} {_n(scored)}")
        if runs:
            parts.append(f"eval/{split_dir.name}: " + ", ".join(runs))
    return _row("runs", "   ".join(parts) or "none")


def exports_row(verify: bool) -> str:
    out = paths.runs() / "export"
    have = [r for r in chain.REPOS if (out / r).is_dir()]
    text = f"{out}: {len(have)}/{len(chain.REPOS)} repos"
    if have and verify:
        problems = chain.verify_export(out, tuple(have))
        text += (
            ", model files identical to the shipped ones"
            if not problems
            else f", {len(problems)} differ: {problems[:3]}"
        )
        cards = chain.changed_cards(out, tuple(have))
        if cards:
            text += f" ({len(cards)} model cards edited since the release)"
    elif have:
        text += " (tst status --verify compares them with shipped.sha256)"
    return _row("exports", text)


def device_row() -> str:
    import torch

    from tunestudio_training import device

    have = device.available()
    try:
        train = device.training_device()
    except SystemExit as e:
        train = f"unavailable ({e})"
    text = f"torch {torch.__version__}, CUDA {'yes' if have['cuda'] else 'no'}, MPS {'yes' if have['mps'] else 'no'}"
    text += f" (training uses {train}"
    if have["mps"] and train != "mps":
        text += ": pass --device mps or set devices.train"
    return _row("device", text + ")")


def next_steps() -> list[str]:
    """One line per model: what's missing for training it, or the command that trains it."""
    lines = []
    for model, chain_steps in chain.CHAINS.items():
        todo = []
        for name in chain_steps:
            if name == "stems":
                continue
            step = chain.STEPS[name]
            state = step.state()
            if state != "ok":
                todo.append(f"{name} {state}: {step.made_by}")
        if todo:
            lines.append(f"  {model:<10} {', then '.join(todo)}   (or tst rebuild {model} <name>)")
        elif model == "boundary":
            lines.append(f"  {model:<10} ready: tst train boundary <name> --backbone {recipes.SHIPPED['aligner']}")
        else:
            lines.append(f"  {model:<10} ready: tst train {model} <name>   (or tst rebuild {model} <name>)")
    goldens = paths.runs() / "goldens"
    if not goldens.is_dir() or not any(goldens.glob("*/calls.json.gz")):
        lines.append(
            f"  {'app':<10} goldens missing: tst eval dev onnx --onnx {paths.runs() / 'export'}, then tst goldens ..."
        )
    return lines


def status(verify: bool = False) -> None:
    for row in (config_row, library_row, stems_row, datasets_row, models_row, runs_row):
        print(row(), flush=True)
    print(exports_row(verify), flush=True)
    print(device_row())
    print("next")
    for line in next_steps():
        print(line)


def _git_tracked_local() -> list[str] | None:
    """Files under training/.local or training/tst.toml that git tracks (None outside git)."""
    try:
        r = subprocess.run(
            ["git", "ls-files", "--", ".local", "tst.toml"], cwd=paths.TRAINING, capture_output=True, text=True
        )
    except OSError:
        return None
    return r.stdout.split() if r.returncode == 0 else None


def doctor() -> int:
    """Print one line per check. 1 if any failed (warnings don't count)."""
    problems = 0

    def report(ok: bool | None, what: str) -> None:
        nonlocal problems
        mark = {True: "ok     ", False: "PROBLEM", None: "note   "}[ok]
        problems += ok is False
        print(f"{mark} {what}", flush=True)

    try:
        config.cache_clear()
        file = config.path()
        for s in config.SETTINGS:
            config.lookup(s.key)
        report(True, f"config: {file}" + ("" if file.exists() else " (none, defaults in use: tst init writes one)"))
    except SystemExit as e:
        report(False, f"config: {e}")
    unknown = config.unknown_env()
    if unknown:
        report(
            False,
            f"unknown variables (typos?): {', '.join(unknown)} (known: {', '.join(s.env for s in config.SETTINGS)})",
        )

    roots = paths.library_roots()
    missing = [str(r) for r in roots if not r.is_dir()]
    report(not missing, "library: " + (f"missing {', '.join(missing)}" if missing else f"{len(roots)} roots"))

    ffmpeg = shutil.which("ffmpeg")
    report(bool(ffmpeg), f"ffmpeg: {ffmpeg}" if ffmpeg else "ffmpeg: not on PATH (every audio file is read with it)")

    try:
        import torch

        cuda_build = torch.version.cuda
        text = f"torch {torch.__version__}, " + (f"CUDA {cuda_build} build" if cuda_build else "no CUDA build")
        if torch.cuda.is_available():
            text += f", GPU {torch.cuda.get_device_name(0)}"
        report(True, text)
        if not cuda_build and not torch.backends.mps.is_available():
            report(
                None,
                "this torch has no CUDA: training runs on the CPU (on Windows with an NVIDIA GPU: uv sync again, "
                "the CUDA wheels come from the pytorch index)",
            )
        if torch.backends.mps.is_available():
            from tunestudio_training import device

            plan = device.memory_plan("mps", 120)
            how = (
                f"batches in {plan['micro_seconds']:g} s micro-batches with gradient checkpointing (same training)"
                if plan["micro_seconds"]
                else "whole batches"
            )
            report(None, f"MPS available ({device.memory_gb() or 0:.0f} GB): tst train ... --device mps runs {how}")
    except ImportError as e:
        report(False, f"torch: {e} (uv sync)")

    try:
        import onnxruntime as ort

        have = ort.get_available_providers()
        wanted = paths.ort_providers()
        lacking = [p for p in wanted if p not in have]
        report(
            not lacking,
            f"ONNX Runtime {ort.__version__}: providers {', '.join(have)}"
            + (f"; devices.onnx asks for {', '.join(lacking)}, which this onnxruntime doesn't have" if lacking else ""),
        )
    except ImportError as e:
        report(False, f"onnxruntime: {e} (uv sync)")

    game = paths.game()
    report(
        (game / "config.json").exists(),
        f"GAME: {game}"
        + (
            ""
            if (game / "config.json").exists()
            else f" missing (unzip openvpi's {recipes.GAME} release there, or set TST_GAME)"
        ),
    )
    aligner = paths.aligner()
    report(
        None if not (aligner / "config.json").exists() else True,
        f"aligner for the pipeline: {aligner}"
        + ("" if (aligner / "config.json").exists() else " missing (tst train aligner, or set TST_ALIGNER)"),
    )
    sep = paths.models() / SEPARATION_MODEL
    report(
        True if sep.exists() else None,
        f"separation model: {sep}" + ("" if sep.exists() else " (downloaded by the first tst stems)"),
    )

    try:
        from huggingface_hub import try_to_load_from_cache

        cached = try_to_load_from_cache(recipes.ALIGNER.base, "config.json")
        report(
            True if isinstance(cached, str) else None,
            f"MMS base {recipes.ALIGNER.base}: "
            + (
                "in the Hugging Face cache"
                if isinstance(cached, str)
                else "not cached yet (downloaded by tst dataset aligner)"
            ),
        )
    except ImportError:
        pass

    data = paths.data()
    probe = next((p for p in (data, *data.parents) if p.exists()), None)
    if probe:
        free = shutil.disk_usage(probe).free / 2**30
        report(
            free > 20,
            f"free space at {probe}: {free:.0f} GB" + ("" if free > 20 else " (stems and clips need tens of GB)"),
        )

    tracked = _git_tracked_local()
    if tracked is not None:
        report(not tracked, "git: nothing local tracked" if not tracked else f"git tracks local files: {tracked[:5]}")
    print("all good" if not problems else f"{problems} problem{'s' if problems > 1 else ''}")
    return 1 if problems else 0
