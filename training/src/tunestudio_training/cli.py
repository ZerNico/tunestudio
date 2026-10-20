"""tst: rebuild, evaluate and export the models Tune Studio ships. Start with `tst init` (where your songs and data
live), then `tst status` shows what's there and what's next. The walk-through is in training/README.md."""

import argparse
import json
import os
import sys
from importlib.metadata import version
from pathlib import Path

from tunestudio_training import chain, config, paths, progress, recipes

REPOS = chain.REPOS
MODELS = ("aligner", "boundary", "notefix", "ends")


class _Help(argparse.ArgumentDefaultsHelpFormatter, argparse.RawDescriptionHelpFormatter):
    """Defaults shown, descriptions and examples kept as written."""


def _examples(*lines: str) -> str:
    return "examples:\n" + "\n".join(f"  {line}" for line in lines)


def _part(spec: str) -> str:
    """--part, checked while parsing, so a typo fails before any work."""
    try:
        progress.part(spec)
    except SystemExit as e:
        raise argparse.ArgumentTypeError(str(e)) from None
    return spec


def _options(raw: str | None) -> dict:
    """Pipeline options as JSON, or "@file.json"."""
    if not raw:
        return {}
    try:
        return json.loads(Path(raw[1:]).read_text() if raw.startswith("@") else raw)
    except (OSError, ValueError) as e:
        raise SystemExit(f"--options: {e}") from None


def _use_onnx(folder: str | None) -> None:
    if folder:  # an environment variable, so per-song processes see it too
        os.environ["TST_ONNX"] = str(Path(folder).resolve())


# --- commands -----------------------------------------------------------------------------------------------------


def _cmd_init(args) -> None:
    file = config.path()
    config.init(
        file,
        force=args.force,
        library=args.library,
        data=args.data,
        stems=args.stems,
        models=args.models,
        runs=args.runs,
        train=args.device,
    )
    print(f"wrote {file}")
    from tunestudio_training import status

    print(status.config_row())
    print(status.library_row())


def _cmd_status(args) -> None:
    from tunestudio_training import status

    status.status(args.verify)


def _cmd_doctor(args) -> None:
    from tunestudio_training import status

    raise SystemExit(status.doctor())


def _cmd_splits(args) -> None:
    from tunestudio_training import splits

    splits.add()


def _cmd_stems(args) -> None:
    from tunestudio_training import stems

    stems.prepare(args.splits, args.part)


def _cmd_dataset(args) -> None:
    if args.kind == "clips":
        from tunestudio_training import clips

        clips.build(original=not args.all, limit=args.limit)
    elif args.kind in ("aligner", "boundary"):
        from tunestudio_training import aligner

        aligner.targets() if args.kind == "aligner" else aligner.boundaries()
    else:
        from tunestudio_training import refiners

        runs = [chain.run_dir(*r.split("/", 1)) for r in args.run or ["train/dump"]]
        refiners.dataset(runs, args.out or chain.notes_path())


def _train_kwargs(args) -> dict:
    """The training options given on the command line (the ones left out take the recipe's defaults)."""
    names = (
        "force", "data", "steps", "lr", "device", "seed", "allow_smoke", "batch_seconds", "micro_batch_seconds",
        "resume", "batch",
    )  # fmt: skip
    out = {k: getattr(args, k) for k in names if getattr(args, k, None) is not None}
    if getattr(args, "backbone", None) is not None:
        out["backbone"] = args.backbone
    return out


def _cmd_train(args) -> None:
    from tunestudio_training import rebuild

    rebuild.train(args.model, args.name, **_train_kwargs(args))


def _cmd_rebuild(args) -> None:
    from tunestudio_training import rebuild

    rebuild.rebuild(args.model, args.name, dry_run=args.dry_run, all_songs=args.all_songs, **_train_kwargs(args))


def _cmd_eval(args) -> None:
    from tunestudio_training import evaluate

    _use_onnx(args.onnx)
    options = _options(args.options)
    if args.game:
        options["game_model"] = str(Path(args.game).resolve())
    if args.dump_notes:
        options["dump_notes"] = True
    evaluate.run(args.split, args.name, options, args.limit, args.part)


def _cmd_compare(args) -> None:
    from tunestudio_training import evaluate

    evaluate.compare(args.split, args.a, args.b, args.by_language)


def _check_stems(given: list[str] | None) -> list[str]:
    """--check's vocal stems; by default the first dev song that has them."""
    if given:
        return given
    from tunestudio_training import library, splits

    for song in splits.songs("dev"):
        stem = library.stems(song)
        if stem:
            print(f"checking the audio models' exports on {song} (--check picks others)")
            return [str(stem / "vocals.flac")]
    print("warning: no dev song has stems: the aligner, FCPE and Beat This! exports go unchecked (tst stems dev)")
    return []


def _cmd_export(args) -> None:
    from tunestudio_training import export
    from tunestudio_training.pipeline import default_learned

    learned = default_learned()
    models = {
        "boundary": args.boundary or Path(learned["boundary_model"]),
        "notefix": args.notefix or Path(learned["notefix"]),
        "ends": args.ends or Path(learned["ends_model"]),
    }
    for key, path in models.items():
        chain.require(path, f"the {key} checkpoint", f"tst train {key} <name>, or --{key}")
    out = args.out or paths.runs() / "export"
    repos = REPOS if args.repo == "all" else (args.repo,)
    audio = any(r != "tunestudio-note-refiners" for r in repos)
    vocals = _check_stems(args.check) if audio else []
    data = args.data or chain.notes_path()
    if args.data:
        chain.require(data, "the notes dataset", "tst dataset notes")
    elif not data.exists():
        data = None  # export_refiners says the check is skipped
    for repo in repos:
        export.export(repo, out / repo, vocals, models, data)
    if args.verify:
        problems = chain.verify_export(out, repos)
        for p in problems:
            print(p)
        if problems:
            raise SystemExit(f"{len(problems)} model files differ from shipped.sha256")
        print(f"{', '.join(repos)}: model files identical to the shipped ones")
        for card in chain.changed_cards(out, repos):
            print(f"  {card}: edited since the release (expected, model-cards/ is copied in)")


def _cmd_goldens(args) -> None:
    from tunestudio_training import goldens

    _use_onnx(args.onnx)
    options = {"game_model": str(Path(args.game).resolve())} if args.game else {}
    out = args.out or paths.runs() / "goldens"
    goldens.dump(args.songs, args.cached, out, paths.runs() / "goldens-work", options)


def _cmd_syllables(args) -> None:
    from tunestudio_training import fixtures

    fixtures.syllable_tables(args.out)


def _cmd_fixtures(args) -> None:
    from tunestudio_training import fixtures

    fixtures.export(args.charting, args.per_language)


def _cmd_fingerprint(args) -> None:
    from tunestudio_training import fingerprint

    argv = [str(p) for p in args.paths]
    argv += ["--save", str(args.save)] if args.save else []
    argv += ["--compare", str(args.compare)] if args.compare else []
    for pattern in args.ignore or []:
        argv += ["--ignore", pattern]
    raise SystemExit(fingerprint.main(argv))


# --- the parser ---------------------------------------------------------------------------------------------------


def _train_args(p: argparse.ArgumentParser, model: str | None) -> None:
    """The training options; `model` None (rebuild) takes all of them."""
    a, b = recipes.ALIGNER, recipes.BOUNDARY
    p.add_argument("--force", action="store_true", help="replace a checkpoint of that name")
    if model in (None, "aligner", "boundary"):
        p.add_argument("--steps", type=int, help=f"default: aligner {a.steps}, boundary {b.steps}")
        p.add_argument("--lr", type=float, help=f"default: aligner {a.lr:g}, boundary {b.lr:g}")
        p.add_argument("--device", choices=config.DEVICES, help="default: TST_DEVICE / devices.train, else auto")
        p.add_argument("--seed", type=int, default=0, help="torch's seed (weights, dropout); batch order is fixed")
        p.add_argument("--allow-smoke", action="store_true", help="train on clips made with --limit")
    if model in (None, "aligner"):
        p.add_argument(
            "--batch-seconds", type=float, help=f"aligner: padded audio per batch (default {a.batch_seconds:g})"
        )
        p.add_argument("--resume", action="store_true", help="aligner: carry on from the last validation's state")
        p.add_argument(
            "--micro-batch-seconds",
            type=float,
            help="aligner: run each batch in pieces of this much audio (same training, less memory; default: what "
            "fits in the memory free now on MPS and small machines, the whole batch on CUDA)",
        )
    if model in (None, "boundary"):
        p.add_argument("--batch", type=int, help=f"boundary: clips per batch (default {b.batch})")
        p.add_argument("--backbone", help="boundary: the aligner, a name under <models>/aligner/ or a folder "
                       "(default: the pipeline's, TST_ALIGNER or " + recipes.SHIPPED["aligner"] + ")")  # fmt: skip
    if model in (None, "notefix", "ends"):
        p.add_argument("--data", type=Path, help="notefix, ends: the notes dataset (default <data>/notes/notes.npz)")


def parser() -> argparse.ArgumentParser:
    top = argparse.ArgumentParser(prog="tst", description=__doc__, formatter_class=_Help)
    top.add_argument("--config", type=Path, help="the config file (default training/tst.toml, or TST_CONFIG)")
    top.add_argument("--version", action="version", version=f"%(prog)s {version('tunestudio-training')}")
    sub = top.add_subparsers(dest="command", required=True, metavar="command")

    def add(name: str, help: str, epilog: str | None = None, **kw) -> argparse.ArgumentParser:
        return sub.add_parser(name, help=help, description=help, epilog=epilog, formatter_class=_Help, **kw)

    p = add(
        "init",
        "write training/tst.toml: where your songs, data, models and runs live",
        _examples("tst init --library ~/USDB\\ Syncer/songs", "tst init --library A --library B --data /big/disk/tst"),
    )
    p.add_argument("--library", action="append", help="a song library root (repeatable)")
    p.add_argument("--data", help="stems and datasets (default .local/data)")
    p.add_argument("--stems", action="append", help="another folder of <song>/vocals.flac + pitch.npz (repeatable)")
    p.add_argument("--models", help="checkpoints, GAME, the separation model (default .local/models)")
    p.add_argument("--runs", help="evaluation runs, exports, goldens (default .local/runs)")
    p.add_argument("--device", choices=config.DEVICES, default="auto", help="the training device")
    p.add_argument("--force", action="store_true", help="replace an existing file")
    p.set_defaults(fn=_cmd_init)

    p = add("status", "what's here and the next step for each model")
    p.add_argument("--verify", action="store_true", help="also hash the exports against shipped.sha256")
    p.set_defaults(fn=_cmd_status)

    p = add(
        "doctor", "check this machine: config, ffmpeg, torch and its devices, GAME, disk, git (exit 1 on a problem)"
    )
    p.set_defaults(fn=_cmd_doctor)

    p = add("splits", "assign songs new in the library to the frozen splits (nothing ever moves)")
    p.add_argument("action", choices=["add"])
    p.set_defaults(fn=_cmd_splits)

    p = add(
        "stems",
        "vocal stems and pitch tracks for the songs of some splits (resumable, ~40 s a song on an M-series Mac)",
        _examples("tst stems train dev test", "tst stems train --part 0/2   # and --part 1/2 in a second terminal"),
    )
    p.add_argument("splits", nargs="+", help="train, dev, test, sel, lang-<language>")
    p.add_argument("--part", type=_part, help="i/n: every n-th song from the i-th, to run n processes side by side")
    p.set_defaults(fn=_cmd_stems)

    p = add(
        "dataset",
        "build a training dataset",
        "clips: line clips of the original train songs and every 4th dev line (a --limit build is a smoke build:\n"
        "  training refuses it without --allow-smoke)\naligner: CTC targets per clip; boundary: syllable starts per "
        "clip (both need clips)\nnotes: label the notes an eval run dumped (tst eval train dump --dump-notes)\n\n"
        + _examples("tst dataset clips", "tst dataset aligner", "tst dataset notes --run train/dump"),
    )
    p.add_argument("kind", choices=["clips", "aligner", "boundary", "notes"])
    p.add_argument("--all", action="store_true", help="clips: every train song, not only the original split's")
    p.add_argument("--limit", type=int, help="clips: the first N songs of train and of dev (a smoke build)")
    p.add_argument("--run", action="append", help="notes: an eval run with dumped notes, <split>/<name> (repeatable)")
    p.add_argument("--out", type=Path, help="notes: the dataset file (default <data>/notes/notes.npz)")
    p.set_defaults(fn=_cmd_dataset)

    p = add(
        "train",
        "train a model into <models> (the shipped recipe unless told otherwise)",
        f"aligner: MMS fine-tuned on the clips, {recipes.ALIGNER.steps} steps at lr {recipes.ALIGNER.lr:g}, the best "
        f"validation loss kept\nboundary: the syllable-start head over a frozen aligner, {recipes.BOUNDARY.steps} "
        f"steps at lr {recipes.BOUNDARY.lr:g}\nnotefix, ends: the note refiners, from the notes dataset\n\n"
        + _examples(
            "tst train aligner aligner-ft3",
            "tst train boundary b2 --backbone aligner-ft3",
            "tst train aligner mps-try --device mps --steps 200",
            "tst train notefix nf5",
        ),
    )
    tsub = p.add_subparsers(dest="model", required=True, metavar="model")
    for model in MODELS:
        tp = tsub.add_parser(model, help=f"train {model}", formatter_class=_Help)
        tp.add_argument(
            "name",
            help="the checkpoint's name, e.g. "
            + {"aligner": "aligner-ft3", "boundary": "b2", "notefix": "nf5", "ends": "e4"}[model],
        )
        _train_args(tp, model)
        tp.set_defaults(fn=_cmd_train, model=model)

    p = add(
        "rebuild",
        "make what a model's training is missing (stems, clips, targets, dump run, notes), then train it",
        _examples("tst rebuild aligner aligner-ft3 --dry-run", "tst rebuild boundary b2 --backbone aligner-ft3"),
    )
    p.add_argument("model", choices=MODELS)
    p.add_argument("name")
    p.add_argument("--dry-run", action="store_true", help="print the plan and stop")
    p.add_argument("--all-songs", action="store_true", help="clips of every train song, not only the original 669")
    _train_args(p, None)
    p.set_defaults(fn=_cmd_rebuild)

    p = add(
        "eval",
        "chart and score every song of a split (resumable)",
        _examples(
            "tst eval dev base",
            'tst eval dev nf5 --options \'{"notefix": ".local/models/notefix/nf5.pkl"}\'',
            "TST_ALIGNER=.local/models/aligner/aligner-ft3 tst eval dev ft3",
            "tst eval dev onnx --onnx .local/runs/export",
        ),
    )
    p.add_argument("split")
    p.add_argument("name")
    p.add_argument("--options", help="pipeline options as JSON or @file.json, e.g. '{\"notefix\": null}'")
    p.add_argument("--game", help="GAME ONNX model dir")
    p.add_argument("--onnx", help="run the learned models from this export folder")
    p.add_argument("--dump-notes", action="store_true", help="write every note's features, for `dataset notes`")
    p.add_argument("--limit", type=int, help="only the first N songs")
    p.add_argument("--part", type=_part, help="i/n: every n-th song from the i-th, to run n processes on one run")
    p.set_defaults(fn=_cmd_eval)

    p = add("compare", "paired comparison of two eval runs", _examples("tst compare dev base nf5 --by-language"))
    p.add_argument("split")
    p.add_argument("a")
    p.add_argument("b")
    p.add_argument("--by-language", action="store_true")
    p.set_defaults(fn=_cmd_compare)

    p = add(
        "export",
        "export a Hugging Face repo's ONNX models, checked against the originals",
        _examples("tst export all --verify", "tst export tunestudio-aligner --boundary .local/models/boundary/b2.pt"),
    )
    p.add_argument("repo", choices=["all", *REPOS])
    p.add_argument("--out", type=Path, help="default <runs>/export")
    p.add_argument("--check", nargs="+", help="vocal stems to check the audio models on (default: a dev song's)")
    p.add_argument(
        "--verify", action="store_true", help="compare the model files with shipped.sha256, exit 1 on a difference"
    )
    p.add_argument("--boundary", type=Path, help="the boundary head (its backbone is found by name)")
    p.add_argument("--notefix", type=Path)
    p.add_argument("--ends", type=Path)
    p.add_argument("--data", type=Path, help="the notes dataset the refiners are checked on")
    p.set_defaults(fn=_cmd_export)

    p = add(
        "goldens",
        "record the goldens of the app's parity tests (ONNX path)",
        _examples('tst goldens "Glasperlenspiel - Echt" --cached .local/runs/eval/dev/onnx --onnx .local/runs/export'),
    )
    p.add_argument("songs", nargs="+")
    p.add_argument("--cached", type=Path, required=True, help="an ONNX eval run of these songs: stems, beats, lyrics")
    p.add_argument("--onnx", required=True, help="the export folder")
    p.add_argument("--game", help="GAME ONNX model dir")
    p.add_argument("--out", type=Path, help="default <runs>/goldens")
    p.set_defaults(fn=_cmd_goldens)

    p = add("syllables", "learn the app's syllable tables from the train split")
    p.add_argument("--out", type=Path, default=paths.CHARTING / "data")
    p.set_defaults(fn=_cmd_syllables)

    p = add("fixtures", "the app's generated text tables and test fixtures")
    p.add_argument("--charting", type=Path, default=paths.CHARTING)
    p.add_argument("--per-language", type=int, default=6000)
    p.set_defaults(fn=_cmd_fixtures)

    p = add(
        "fingerprint",
        "content hashes of outputs (npz by array, gz decompressed), to check a change made the same files",
        _examples(
            "tst fingerprint .local/data/clips --save before.json",
            "tst fingerprint .local/data/clips --compare before.json",
        ),
    )
    p.add_argument("paths", nargs="+", type=Path)
    p.add_argument("--save", type=Path)
    p.add_argument("--compare", type=Path)
    p.add_argument("--ignore", action="append", help="glob of file names to leave out (adds to the defaults)")
    p.set_defaults(fn=_cmd_fingerprint)
    return top


# What to say when Ctrl-C stops a command: these carry on where they stopped when run again.
RESUMABLE = ("stems", "eval", "rebuild")


def _interrupted(args) -> str:
    if args.command in RESUMABLE:
        return "interrupted: run the same command again to carry on"
    if args.command == "train" and args.model == "aligner":
        return f"interrupted: tst train aligner {args.name} --resume carries on from the last validation"
    return "interrupted"


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    if args.config:
        os.environ["TST_CONFIG"] = str(args.config.expanduser().resolve())  # per-song processes read it too
        config.cache_clear()
    try:
        args.fn(args)
    except chain.Missing as e:
        print(f"error: {e}", file=sys.stderr)
        raise SystemExit(2) from None
    except KeyboardInterrupt:
        print(f"\n{_interrupted(args)}", file=sys.stderr)
        raise SystemExit(130) from None


if __name__ == "__main__":
    main()
