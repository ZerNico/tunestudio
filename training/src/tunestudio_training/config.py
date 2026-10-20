"""Settings: where songs, data, models and runs live, and which devices to use. Each one comes from, in this order:
a command-line flag (flags that matter to the per-song processes set the variable, so those see it too), its `TST_*`
environment variable, `training/tst.toml` (`tst init` writes it, git-ignored), else the default, which points into
the git-ignored `training/.local/`.

`TST_CONFIG` (or `tst --config`) names another config file. Relative paths in the file are relative to the file's
folder; paths in variables are taken as given. Lists are TOML lists in the file and separated like PATH in variables
(`:` on macOS and Linux), except the ONNX Runtime providers, which are comma-separated like before. `tst status`
shows every value and where it came from.

TST_ONNX is not a setting here on purpose: it changes what an evaluation measures, so it's a flag (`--onnx`) or a
variable, never something a file sets and you forget about.
"""

import json
import os
import tomllib
from dataclasses import dataclass
from functools import cache
from pathlib import Path

TRAINING = Path(__file__).resolve().parents[2]
LOCAL = TRAINING / ".local"
DEVICES = ("auto", "cuda", "mps", "cpu")


@dataclass(frozen=True)
class Setting:
    key: str  # "section.name" in tst.toml
    env: str  # the environment variable
    kind: str  # "path", "paths" (list of paths), "str", "strs" (list of strings)
    help: str
    # The default, or None when another setting decides it (the aligner and GAME are found under the models folder).
    default: object = None
    separator: str = os.pathsep  # of a list in the variable


SETTINGS = (
    Setting("paths.library", "TST_LIBRARY", "paths", "song library roots, one folder per song", [LOCAL / "library"]),
    Setting("paths.data", "TST_DATA", "path", "vocal stems (stems/<song>/) and the datasets", LOCAL / "data"),
    Setting("paths.stems", "TST_STEMS", "paths", "more <song>/vocals.flac + pitch.npz folders to reuse", []),
    Setting("paths.models", "TST_MODELS", "path", "checkpoints, GAME, the separation model", LOCAL / "models"),
    Setting("paths.runs", "TST_RUNS", "path", "evaluation runs, exports, goldens", LOCAL / "runs"),
    Setting(
        "models.aligner", "TST_ALIGNER", "path", "the aligner the pipeline uses (default <models>/aligner/aligner-ft2)"
    ),
    Setting("models.game", "TST_GAME", "path", "GAME's ONNX models (default <models>/game/GAME-1.0.3-large-onnx)"),
    Setting("devices.train", "TST_DEVICE", "str", "training device: " + ", ".join(DEVICES), "auto"),
    Setting(
        "devices.onnx", "TST_ORT_PROVIDERS", "strs", "GAME's ONNX Runtime providers", ["CPUExecutionProvider"], ","
    ),
)
BY_KEY = {s.key: s for s in SETTINGS}
# Variables tst reads that aren't settings of the file.
OTHER_ENV = ("TST_CONFIG", "TST_ONNX")


class ConfigError(SystemExit):
    """A config file tst can't use, with what to do about it."""


def path() -> Path:
    """The config file: TST_CONFIG, else training/tst.toml (whether or not it exists)."""
    value = os.environ.get("TST_CONFIG")
    return Path(value).expanduser().resolve() if value else TRAINING / "tst.toml"


def _flatten(raw: dict, file: Path) -> dict[str, object]:
    out = {}
    for section, values in raw.items():
        if not isinstance(values, dict):
            raise ConfigError(f"{file}: `{section}` isn't a section. Valid keys: {', '.join(BY_KEY)}")
        for name, value in values.items():
            key = f"{section}.{name}"
            if key not in BY_KEY:
                raise ConfigError(f"{file}: unknown key `{key}`. Valid keys: {', '.join(BY_KEY)}")
            out[key] = value
    return out


@cache
def _read(file: str) -> dict[str, object]:
    p = Path(file)
    if not p.exists():
        if os.environ.get("TST_CONFIG"):
            raise ConfigError(f"config file not found: {p} (from TST_CONFIG or --config)")
        return {}
    try:
        raw = tomllib.loads(p.read_text(encoding="utf8"))
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{p}: {e}") from None
    return _flatten(raw, p)


def _table() -> dict[str, object]:
    """The config file's values, by key (cached per file, `cache_clear` after changing it)."""
    return _read(str(path()))


def cache_clear() -> None:
    _read.cache_clear()


def _convert(setting: Setting, value: object, base: Path | None) -> object:
    """A raw value (a string from a variable, or what TOML gave) as the setting's type. `base`: the config file's
    folder, which relative paths in the file are relative to (None for variables: taken as given)."""

    def as_path(v: object) -> Path:
        if not isinstance(v, str):
            raise ConfigError(f"{setting.key} must be a path (a string), got {v!r}")
        p = Path(v).expanduser()
        return base / p if base is not None and not p.is_absolute() else p

    def as_list(v: object) -> list:
        if isinstance(v, str):
            return [x for x in v.split(setting.separator) if x] if base is None else [v]
        if isinstance(v, list):
            return v
        raise ConfigError(f"{setting.key} must be a list, got {v!r}")

    if setting.kind == "path":
        return as_path(value)
    if setting.kind == "paths":
        return [as_path(v) for v in as_list(value)]
    if setting.kind == "strs":
        return [str(v).strip() for v in as_list(value)]
    if not isinstance(value, str):
        raise ConfigError(f"{setting.key} must be a string, got {value!r}")
    if setting.key == "devices.train" and value not in DEVICES:
        raise ConfigError(f"{setting.key} (or {setting.env}) must be one of {', '.join(DEVICES)}, got {value!r}")
    return value


def lookup(key: str) -> tuple[object, str]:
    """A setting's value and where it came from: the variable's name, "tst.toml" (the file's name) or "default".
    The value is None when the default is decided elsewhere (models.aligner, models.game)."""
    setting = BY_KEY[key]
    table = _table()  # read (and checked) even when a variable decides, so a broken file is never a surprise later
    env = os.environ.get(setting.env)
    if env:  # an empty variable counts as unset, like before
        return _convert(setting, env, None), setting.env
    if key in table:
        return _convert(setting, table[key], path().parent), path().name
    default = setting.default
    return (list(default) if isinstance(default, list) else default), "default"


def value(key: str) -> object:
    return lookup(key)[0]


def unknown_env() -> list[str]:
    """TST_* variables tst doesn't know, likely typos (TST_DATAS)."""
    known = {s.env for s in SETTINGS} | set(OTHER_ENV)
    return sorted(k for k in os.environ if k.startswith("TST_") and k not in known)


TEMPLATE = """\
# Where tst finds songs and keeps its data. Git-ignored. TST_* environment variables override any value here.
# Relative paths are relative to this file. `tst status` shows each value and where it came from.

[paths]
library = {library}  # TST_LIBRARY: one folder per song
data = {data}  # TST_DATA: stems/<song>/ and the datasets
stems = {stems}  # TST_STEMS: more <song>/vocals.flac + pitch.npz folders to reuse
models = {models}  # TST_MODELS: checkpoints, GAME, the separation model
runs = {runs}  # TST_RUNS: evaluation runs, exports, goldens

[models]
# aligner = ".local/models/aligner/aligner-ft2"  # TST_ALIGNER: the aligner the pipeline uses
# game = ".local/models/game/GAME-1.0.3-large-onnx"  # TST_GAME

[devices]
train = {train}  # TST_DEVICE: auto (CUDA if there is one, else CPU), cuda, mps, cpu
onnx = ["CPUExecutionProvider"]  # TST_ORT_PROVIDERS: GAME's ONNX Runtime providers
"""


def _relative(p: str, base: Path) -> str:
    """A path as `tst init` writes it: relative to the file's folder when it's inside it, else absolute. Paths given
    relative are taken relative to the current folder, like any command-line path."""
    full = Path(p).expanduser().resolve()
    try:
        return full.relative_to(base.resolve()).as_posix()
    except ValueError:
        return str(full)


def render(
    file: Path,
    library: list[str] | None = None,
    data: str | None = None,
    stems: list[str] | None = None,
    models: str | None = None,
    runs: str | None = None,
    train: str = "auto",
) -> str:
    """The text `tst init` writes. Values are quoted with json.dumps, which TOML reads as basic strings."""
    base = file.parent

    def one(p: str | None, default: str) -> str:
        return json.dumps(_relative(p, base) if p else default)

    def many(ps: list[str] | None, default: list[str]) -> str:
        items = [_relative(p, base) for p in ps] if ps else default
        return "[" + ", ".join(json.dumps(x) for x in items) + "]"

    if train not in DEVICES:
        raise ConfigError(f"--device must be one of {', '.join(DEVICES)}")
    return TEMPLATE.format(
        library=many(library, [".local/library"]),
        data=one(data, ".local/data"),
        stems=many(stems, []),
        models=one(models, ".local/models"),
        runs=one(runs, ".local/runs"),
        train=json.dumps(train),
    )


def init(file: Path, force: bool = False, **values) -> Path:
    """Write the config file (refusing to replace one without `force`) and check that it reads back."""
    if file.exists() and not force:
        raise ConfigError(f"{file} exists already (--force replaces it)")
    text = render(file, **values)
    _flatten(tomllib.loads(text), file)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding="utf8")
    cache_clear()
    return file
