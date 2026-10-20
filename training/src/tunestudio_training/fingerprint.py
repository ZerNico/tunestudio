"""Content hashes of training outputs, to check that a change to the code didn't change what it makes.

Only reads, with the standard library and NumPy. Per file, the sha256 of:
- `.npz`: every array (name, dtype, shape and data), not the zip, whose timestamps change on every save
- `.gz`: the decompressed data (gzip writes the time into the header)
- `.json`: the parsed data written back with sorted keys, so key order and whitespace don't count
- everything else: the bytes

    tst fingerprint OUT... --save before.json
    tst fingerprint OUT... --compare before.json

Folders are walked recursively and keyed by their path relative to the folder given. `--ignore` takes glob patterns
of names to leave out (the clips' `build.json` and training logs are new and differ between runs).
"""

import argparse
import fnmatch
import gzip
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

IGNORE = ("build.json", "*.log", ".resume.pt", ".DS_Store")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_hash(path: Path) -> str | dict[str, str]:
    """One hash per file, or one per array for `.npz`."""
    if path.suffix == ".npz":
        with np.load(path, allow_pickle=False) as d:
            return {
                k: _sha(f"{d[k].dtype.str}{d[k].shape}".encode() + np.ascontiguousarray(d[k]).tobytes())
                for k in sorted(d.files)
            }
    if path.suffix == ".gz":
        with gzip.open(path, "rb") as f:
            return _sha(f.read())
    if path.suffix == ".json":
        try:
            data = json.loads(path.read_bytes())
        except ValueError:
            return _sha(path.read_bytes())
        return _sha(json.dumps(data, sort_keys=True, ensure_ascii=False).encode())
    return _sha(path.read_bytes())


def fingerprint(targets: list[Path], ignore: tuple[str, ...] = IGNORE) -> dict[str, str | dict[str, str]]:
    """Hashes of every file under `targets`: keyed by the path relative to each folder, or by the file's name."""
    out: dict[str, str | dict[str, str]] = {}
    for target in targets:
        files = sorted(p for p in target.rglob("*") if p.is_file()) if target.is_dir() else [target]
        for p in files:
            if any(fnmatch.fnmatch(p.name, pat) for pat in ignore):
                continue
            key = p.relative_to(target).as_posix() if target.is_dir() else p.name
            if len(targets) > 1 and target.is_dir():
                key = f"{target.name}/{key}"
            out[key] = file_hash(p)
    return out


def compare(before: dict, after: dict) -> list[str]:
    """Plain-language differences, empty if none."""
    problems = []
    for key in sorted(set(before) | set(after)):
        if key not in after:
            problems.append(f"missing now: {key}")
        elif key not in before:
            problems.append(f"new: {key}")
        elif before[key] != after[key]:
            a, b = before[key], after[key]
            if isinstance(a, dict) and isinstance(b, dict):
                arrays = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
                problems.append(f"differs: {key} (arrays {', '.join(arrays)})")
            else:
                problems.append(f"differs: {key}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tst fingerprint", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--save", type=Path, help="write the hashes to this JSON file")
    parser.add_argument("--compare", type=Path, help="compare with hashes saved before, exit 1 on a difference")
    parser.add_argument("--ignore", action="append", default=list(IGNORE), help="glob of file names to leave out")
    args = parser.parse_args(argv)
    found = fingerprint(args.paths, tuple(args.ignore))
    if args.save:
        args.save.parent.mkdir(parents=True, exist_ok=True)
        args.save.write_text(json.dumps(found, indent=1, sort_keys=True, ensure_ascii=False) + "\n")
        print(f"{len(found)} files -> {args.save}")
    if args.compare:
        problems = compare(json.loads(args.compare.read_text()), found)
        for line in problems[:50]:
            print(line)
        if len(problems) > 50:
            print(f"... and {len(problems) - 50} more")
        print(f"{len(found)} files, {len(problems)} differences")
        return 1 if problems else 0
    if not args.save:
        print(json.dumps(found, indent=1, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
