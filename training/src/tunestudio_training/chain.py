"""What each model is built from, where every piece lives and which command makes it: one table that `tst status`,
the prerequisite checks of the commands (`require`) and `tst rebuild` share.

    stems (tst stems)
      -> clips (tst dataset clips) -> targets (tst dataset aligner)   -> aligner checkpoint (tst train aligner)
                                   -> boundaries (tst dataset boundary) -> boundary head (tst train boundary)
      -> dump run (tst eval train dump --dump-notes) -> notes (tst dataset notes) -> notefix / ends (tst train ...)

A step is stale when it's older than what it was made from, or when the clips were a smoke build (`--limit`) or made
from other splits than the current manifest. Light on purpose (no torch), so `tst status` is quick.
"""

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from tunestudio_training import paths, recipes


class Missing(Exception):
    """Something a command needs isn't there. The CLI prints it with the command that makes it and exits with 2."""

    def __init__(self, what: str, path: Path | str, make: str | None = None):
        super().__init__(what, path, make)
        self.what, self.path, self.make = what, Path(path), make

    def __str__(self) -> str:
        return f"{self.what} not found at {self.path}" + (f"\n  make it with: {self.make}" if self.make else "")


def require(path: Path, what: str, make: str | None = None) -> Path:
    """`path`, or Missing if it doesn't exist."""
    if not Path(path).exists():
        raise Missing(what, path, make)
    return path


# Where every piece lives (the modules that make them use the same functions).
def clips_dir() -> Path:
    return paths.data() / "clips"


def aligner_data() -> Path:
    return paths.data() / "aligner"


def targets_path() -> Path:
    return aligner_data() / "targets.json"


def boundaries_path() -> Path:
    return aligner_data() / "boundaries.json"


def notes_path() -> Path:
    return paths.data() / "notes" / "notes.npz"


def run_dir(split: str, name: str) -> Path:
    return paths.runs() / "eval" / split / name


def dump_run() -> Path:
    """The evaluation run the note refiners learn from (every train song's notes before any correction)."""
    return run_dir("train", "dump")


def checkpoint(model: str, name: str) -> Path:
    """A checkpoint by model kind and name: aligner/<name>/, boundary/<name>.pt, notefix/<name>.pkl, ends/<name>.pkl.
    A name with a slash is taken as a path."""
    if "/" in name or "\\" in name:
        return Path(name).expanduser()
    folder = paths.models() / model
    return folder / name if model == "aligner" else folder / f"{name}{'.pt' if model == 'boundary' else '.pkl'}"


def is_checkpoint(model: str, path: Path) -> bool:
    return (path / "config.json").exists() if model == "aligner" else path.is_file()


def manifest_sha1() -> str:
    return hashlib.sha1((paths.SPLITS / "manifest.json").read_bytes()).hexdigest()


def clips_build() -> dict | None:
    """The clips' build.json (what `tst dataset clips` was asked for), None for clips made before it was written."""
    f = clips_dir() / "build.json"
    return json.loads(f.read_text()) if f.exists() else None


def clips_stale() -> str | None:
    """Why the clips shouldn't be trained on, if they shouldn't."""
    build = clips_build()
    if build is None:
        return None  # older clips: nothing recorded, nothing to object to
    if build.get("limit"):
        return f"a smoke build (--limit {build['limit']})"
    if build.get("splits_manifest_sha1") != manifest_sha1():
        return "made from other splits than splits/manifest.json"
    return None


def _mtime(p: Path) -> float:
    return p.stat().st_mtime if p.exists() else 0.0


def older_than(path: Path, *inputs: Path) -> bool:
    """`path` was made before one of its inputs changed."""
    return path.exists() and any(_mtime(path) < _mtime(i) for i in inputs if i.exists())


@dataclass(frozen=True)
class Step:
    """One piece of a model's chain."""

    name: str
    path: Callable[[], Path]
    made_by: str
    needs: tuple[str, ...]
    stale: Callable[[], str | None] = lambda: None

    def present(self) -> bool:
        p = self.path()
        if self.name == "clips":
            return (p / "train" / "index.txt").exists() and (p / "valid" / "index.txt").exists()
        if self.name == "dump":
            return p.is_dir() and any(p.glob("*/notes.json"))
        return p.exists()

    def state(self) -> str:
        """ "ok", "missing" or "stale: why"."""
        if not self.present():
            return "missing"
        why = self.stale()
        return f"stale: {why}" if why else "ok"


def _clips_index() -> Path:
    return clips_dir() / "train" / "index.txt"


def _newest_notes() -> Path:
    return max(dump_run().glob("*/notes.json"), key=_mtime, default=dump_run() / "run.json")


STEPS = {
    s.name: s
    for s in (
        Step("clips", clips_dir, "tst dataset clips", ("stems",), clips_stale),
        Step(
            "targets",
            targets_path,
            "tst dataset aligner",
            ("clips",),
            lambda: "older than the clips" if older_than(targets_path(), _clips_index()) else None,
        ),
        Step(
            "boundaries",
            boundaries_path,
            "tst dataset boundary",
            ("clips",),
            lambda: "older than the clips" if older_than(boundaries_path(), _clips_index()) else None,
        ),
        Step("dump", dump_run, "tst eval train dump --dump-notes", ("stems",)),
        Step(
            "notes",
            notes_path,
            "tst dataset notes",
            ("dump",),
            lambda: "older than the dump run" if older_than(notes_path(), _newest_notes()) else None,
        ),
    )
}
# What each model's training reads, in the order a rebuild makes them.
CHAINS = {
    "aligner": ("stems", "clips", "targets"),
    "boundary": ("stems", "clips", "boundaries"),
    "notefix": ("stems", "dump", "notes"),
    "ends": ("stems", "dump", "notes"),
}


def require_step(name: str) -> Path:
    """A dataset step's output, or Missing with the command that makes it."""
    step = STEPS[name]
    if not step.present():
        what = {"clips": "the line clips", "targets": "the aligner's CTC targets", "dump": "the dump run"}
        raise Missing(what.get(name, f"the {name} dataset"), step.path(), step.made_by)
    return step.path()


def shipped_checkpoint(model: str) -> Path:
    return checkpoint(model, recipes.SHIPPED[model])


REPOS = ("tunestudio-aligner", "tunestudio-note-refiners", "fcpe-onnx", "beat-this-onnx")


def shipped_hashes() -> dict[str, str]:
    """`<repo>/<file>` -> sha256 of the files on Hugging Face (shipped.sha256, `sha256sum` format)."""
    out = {}
    for line in paths.SHIPPED.read_text().splitlines():
        if line.strip():
            digest, name = line.split(maxsplit=1)
            out[name.strip()] = digest
    return out


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# The model cards: copied into the exports from model-cards/, and edited between releases (the hashes in
# shipped.sha256 are the released ones). Everything else must stay byte for byte the same.
CARDS = ("README.md",)


def verify_export(folder: Path, repos: tuple[str, ...] = REPOS) -> list[str]:
    """Differences between an export folder's model files and the shipped ones of `repos` (empty: byte for byte the
    same). Model cards (CARDS) are left out: they are expected to change."""
    problems = []
    for name, digest in shipped_hashes().items():
        repo, _, file = name.partition("/")
        if repo not in repos or file in CARDS:
            continue
        f = folder / name
        if not f.exists():
            problems.append(f"missing: {name}")
        elif _sha256(f) != digest:
            problems.append(f"differs from the shipped file: {name}")
    return problems


def changed_cards(folder: Path, repos: tuple[str, ...] = REPOS) -> list[str]:
    """The model cards in an export that differ from the released ones (expected after editing model-cards/)."""
    return [
        name
        for name, digest in shipped_hashes().items()
        if name.partition("/")[0] in repos
        and name.partition("/")[2] in CARDS
        and (folder / name).exists()
        and _sha256(folder / name) != digest
    ]
