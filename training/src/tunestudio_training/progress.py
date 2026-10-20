"""Progress of the long commands: per-song lines with the time left, a summary at the end, failures with their whole
error kept in a log next to the song's files, and `--part i/n` for running several processes on one job.
"""

import sys
import time
from collections import Counter
from pathlib import Path
from typing import TextIO


def part(spec: str | None) -> tuple[int, int] | None:
    """`--part i/n` as (i, n): every n-th song from the i-th (0-based), so n processes can share one job."""
    if not spec:
        return None
    try:
        i, n = (int(x) for x in spec.split("/"))
    except ValueError:
        raise SystemExit(f"--part takes i/n, e.g. 0/2 and 1/2 for two processes, not {spec!r}") from None
    if n < 1 or not 0 <= i < n:
        raise SystemExit(f"--part {spec}: needs 0 <= i < n, e.g. 0/2 and 1/2 for two processes")
    return i, n


def select(items: list, spec: str | None) -> list:
    """The items of `--part i/n` (all without one)."""
    p = part(spec)
    return items[p[0] :: p[1]] if p else items


def duration(seconds: float) -> str:
    """3h10m, 12m, 40s."""
    seconds = int(round(seconds))
    if seconds >= 3600:
        return f"{seconds // 3600}h{seconds % 3600 // 60:02d}m"
    if seconds >= 60:
        return f"{seconds // 60}m"
    return f"{seconds}s"


class Progress:
    """`[i/n] song: status (Ns), ~1h20m left` lines for a list of items, where the time left is the mean time of the
    items done so far (skipped ones don't count) times the items still to do. `summary()` counts the statuses."""

    def __init__(self, total: int, out: TextIO | None = None):
        self.total, self.out = total, out or sys.stdout
        self.counts: Counter = Counter()
        self.spent, self.timed = 0.0, 0

    def done(self, i: int, name: str, status: str, seconds: float | None = None) -> None:
        """Item `i` (0-based) finished with `status` ("ok", "FAILED ...") after `seconds` (None: skipped)."""
        self.counts["failed" if status.startswith("FAILED") else status] += 1
        line = f"[{i + 1}/{self.total}] {name}: {status}"
        if seconds is not None:
            self.spent += seconds
            self.timed += 1
            line += f" ({seconds:.0f}s)"
            left = self.total - (i + 1)
            if left > 0:
                line += f", ~{duration(self.spent / self.timed * left)} left"
        print(line, file=self.out, flush=True)

    def summary(self, what: str = "songs") -> str:
        parts = ", ".join(f"{n} {status}" for status, n in sorted(self.counts.items()))
        line = f"{self.total} {what}: {parts or 'nothing to do'}"
        print(line, file=self.out, flush=True)
        return line


def failure(work: Path, stderr: str) -> str:
    """Keep a failed subprocess's whole stderr in `<work>/error.log`. Returns the status line: the error's last line
    and where the log is."""
    work.mkdir(parents=True, exist_ok=True)
    log = work / "error.log"
    log.write_text(stderr)
    last = (stderr.strip().splitlines() or ["?"])[-1][:200]
    return f"FAILED {last} (all of it: {log})"


class Eta:
    """Time left of a training loop: `eta(step)` after `step` of `total` steps."""

    def __init__(self, total: int):
        self.total, self.start = total, time.time()

    def __call__(self, step: int) -> str:
        if step <= 0 or step >= self.total:
            return ""
        return f", ~{duration((time.time() - self.start) / step * (self.total - step))} left"


class Log:
    """Print and append to a log file (a training's `train.log`), so a run's output survives the terminal."""

    def __init__(self, path: Path | None):
        self.path = path
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            self.file = open(path, "a", encoding="utf8")  # noqa: SIM115

    def __call__(self, *parts) -> None:
        line = " ".join(str(p) for p in parts)
        print(line, flush=True)
        if self.path:
            self.file.write(line + "\n")
            self.file.flush()
