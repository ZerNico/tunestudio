"""`tst train` and `tst rebuild`: train a model under a new name, or make whatever its training is still missing first
(stems, clips, targets, the dump run, the notes dataset) and then train it. Both refuse to replace a checkpoint
without --force (the shipped ones by name), and the aligner and the boundary head refuse a smoke build of the clips.

`rebuild` runs the same functions as the single commands, skips what's there and up to date, and prints its plan
with estimates first (`--dry-run` stops there). It never judges the result: it prints the commands that do.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from tunestudio_training import chain, paths, progress, recipes

# Rough times per song on an M-series Mac, for the plan.
STEMS_SECONDS = 40
EVAL_SECONDS = 150
CLIPS_SECONDS = 0.5


def backbone_path(backbone: str | Path | None) -> Path:
    """The boundary head's aligner: a name under <models>/aligner/, a folder, or the pipeline's aligner."""
    if backbone is None:
        return paths.aligner()
    p = Path(backbone).expanduser()
    return p if p.exists() or len(p.parts) > 1 else chain.checkpoint("aligner", str(backbone))


def guard(model: str, name: str, force: bool) -> Path:
    """Where `tst train <model> <name>` writes, or SystemExit if something is there and `force` isn't set."""
    out = chain.checkpoint(model, name)
    there = (out / "config.json").exists() if model == "aligner" else out.exists()
    if there and not force:
        shipped = f" ({name} is the shipped {model}{' head' if model == 'boundary' else ''})"
        note = shipped if name == recipes.SHIPPED[model] else ""
        raise SystemExit(f"{out} exists{note}: pick a new name, or --force to replace it")
    return out


def _clips_ok(allow_smoke: bool) -> None:
    why = chain.clips_stale()
    if why and not allow_smoke:
        raise SystemExit(f"the clips are {why}: build them again (tst dataset clips), or --allow-smoke to train anyway")


def train(
    model: str,
    name: str,
    *,
    force: bool = False,
    allow_smoke: bool = False,
    steps: int | None = None,
    lr: float | None = None,
    batch_seconds: float | None = None,
    micro_batch_seconds: float | None = None,
    batch: int | None = None,
    backbone: str | Path | None = None,
    data: Path | None = None,
    device: str | None = None,
    seed: int = 0,
    resume: bool = False,
) -> Path:
    """Train one model into <models>. The defaults are the shipped recipe (recipes.py)."""
    out = guard(model, name, force or resume)
    if model in ("aligner", "boundary"):
        from tunestudio_training import aligner

        chain.require_step("clips")
        _clips_ok(allow_smoke)
        tuning = {k: v for k, v in (("steps", steps), ("lr", lr)) if v is not None}
        if model == "aligner":
            chain.require_step("targets")
            aligner.train_aligner(
                out,
                max_seconds=batch_seconds or recipes.ALIGNER.batch_seconds,
                device=device,
                seed=seed,
                resume=resume,
                micro_seconds=micro_batch_seconds,
                **tuning,
            )
        else:
            chain.require_step("boundaries")
            bb = backbone_path(backbone)
            chain.require(bb / "config.json", "the boundary head's aligner", "tst train aligner <name>")
            if bb.resolve().parent != (paths.models() / "aligner").resolve():
                print(f"note: the head finds its aligner by name under {paths.models() / 'aligner'}/: {bb.name}")
            aligner.train_boundary(bb, out, batch=batch or recipes.BOUNDARY.batch, device=device, seed=seed, **tuning)
    else:
        from tunestudio_training import refiners

        source = data or chain.notes_path()
        fn = refiners.train_notefix if model == "notefix" else refiners.train_ends
        fn(source, out)
    return out


@dataclass
class Action:
    label: str
    run: Callable[[], None] | None = None  # None: nothing to do, only reported
    notes: list[str] = field(default_factory=list)


def _missing_stems(songs: list[str]) -> list[str]:
    from tunestudio_training import library

    return [s for s in songs if not library.stems(s)]


def plan(model: str, name: str, all_songs: bool = False, backbone: str | None = None, **train_kwargs) -> list[Action]:
    """What `tst rebuild <model> <name>` would do, in order."""
    from tunestudio_training import splits, stems

    actions: list[Action] = []
    if model in ("aligner", "boundary"):
        songs = splits.songs("train", original=not all_songs) + splits.songs("dev")
        missing = _missing_stems(songs)
        if missing:
            actions.append(
                Action(
                    f"stems: {len(missing):,} of {len(songs):,} songs missing "
                    f"(~{progress.duration(len(missing) * STEMS_SECONDS)})",
                    lambda: stems.prepare_songs(missing),
                )
            )
        else:
            actions.append(Action(f"stems: all {len(songs):,} songs have them"))
        build = chain.clips_build()
        clips_state = chain.STEPS["clips"].state()
        wrong_kind = (build is not None and build.get("original") != (not all_songs)) or (build is None and all_songs)
        rebuild_clips = bool(missing) or clips_state != "ok" or wrong_kind
        if rebuild_clips:
            from tunestudio_training import clips

            why = "new stems" if missing else clips_state if clips_state != "ok" else "other songs asked for"
            actions.append(
                Action(
                    f"clips: build ({why}, ~{progress.duration(len(songs) * CLIPS_SECONDS)})",
                    lambda: clips.build(original=not all_songs),
                )
            )
        else:
            actions.append(Action("clips: up to date"))
        step = "targets" if model == "aligner" else "boundaries"
        state = chain.STEPS[step].state()
        if rebuild_clips or state != "ok":
            from tunestudio_training import aligner

            fn = aligner.targets if model == "aligner" else aligner.boundaries
            actions.append(Action(f"{step}: {'make' if state == 'missing' else 'make again'} (minutes)", fn))
        else:
            actions.append(Action(f"{step}: up to date"))
        if model == "boundary":
            bb = backbone_path(backbone)
            if not (bb / "config.json").exists():
                raise chain.Missing("the boundary head's aligner", bb, "tst rebuild aligner <name> first")
    else:
        from tunestudio_training import evaluate, refiners

        songs = splits.songs("train")
        missing = _missing_stems(songs)
        if missing:
            actions.append(
                Action(
                    f"stems: {len(missing):,} of {len(songs):,} train songs missing "
                    f"(~{progress.duration(len(missing) * STEMS_SECONDS)})",
                    lambda: stems.prepare_songs(missing),
                )
            )
        run = chain.dump_run()
        done = sum(1 for _ in run.glob("*/scores.json")) if run.is_dir() else 0
        todo = len(songs) - done
        if todo > 0:
            actions.append(
                Action(
                    f"eval train dump: {todo:,} songs (~{progress.duration(todo * EVAL_SECONDS)}, resumable)",
                    lambda: evaluate.run("train", "dump", {"dump_notes": True}),
                    [f"the dump runs the current pipeline: aligner {paths.aligner().name}, boundary head "
                     f"{recipes.SHIPPED['boundary']}"],
                )
            )  # fmt: skip
        else:
            actions.append(Action(f"eval train dump: all {done:,} songs done"))
        state = chain.STEPS["notes"].state()
        if todo > 0 or state != "ok":
            actions.append(
                Action("notes: label the dump (minutes)", lambda: refiners.dataset([run], chain.notes_path()))
            )
        else:
            actions.append(Action("notes: up to date"))
    out = chain.checkpoint(model, name)
    actions.append(
        Action(
            f"train {model} {name} -> {out}",
            lambda: train(model, name, backbone=backbone, **train_kwargs),
        )
    )
    return actions


def judge(model: str, name: str) -> list[str]:
    """The commands that decide whether the new model is better (README, Judging)."""
    out = chain.checkpoint(model, name)
    if model == "aligner":
        first = f"TST_ALIGNER={out} tst eval dev {name}"
    else:
        key = {"boundary": "boundary_model", "notefix": "notefix", "ends": "ends_model"}[model]
        first = f"tst eval dev {name} --options '{json.dumps({key: str(out)})}'"
    return [first, f"tst compare dev base {name} --by-language"]


def rebuild(model: str, name: str, dry_run: bool = False, all_songs: bool = False, **train_kwargs) -> None:
    guard(model, name, train_kwargs.get("force", False))
    actions = plan(model, name, all_songs=all_songs, **train_kwargs)
    print(f"rebuild {model} {name}:")
    for a in actions:
        print(f"  {'-' if a.run else 'ok'} {a.label}")
        for note in a.notes:
            print(f"      {note}")
    if not dry_run:
        for a in actions:
            if a.run:
                print(f"\n== {a.label}", flush=True)
                a.run()
    print("\nthen judge it end to end (README, Judging):")
    for line in judge(model, name):
        print(f"  {line}")
