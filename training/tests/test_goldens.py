import dataclasses
import math
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from tunestudio_training import goldens


@dataclasses.dataclass
class Point:
    x: float
    tags: set


def test_plain():
    rec = goldens.Recorder()
    big = np.arange(100, dtype=np.float32)
    out = rec.plain(
        {
            "nan": float("nan"),
            "inf": -math.inf,
            "small": np.array([1, 2]),
            "big": big,
            "point": Point(np.float64(1.5), {3, 1}),
            "path": Path("/x"),
            "tuple": (np.int64(2), np.bool_(True)),
        }
    )
    assert out["nan"] == {"$float": "nan"} and out["inf"] == {"$float": "-inf"}
    assert out["small"] == [1, 2]
    key = out["big"]["$array"]
    assert key.startswith("float32-100-") and np.array_equal(rec.arrays[key], big)
    assert out["point"] == {"$type": "Point", "x": 1.5, "tags": {"$set": [1, 3]}}
    assert out["path"] == "/x" and out["tuple"] == [2, True]
    assert rec.plain(object())["$repr"].startswith("<object")


def test_wrap_records_calls_and_changed_arguments():
    rec = goldens.Recorder()

    def grow(items, by=1):
        items.append(by)
        return len(items)

    owner = SimpleNamespace(grow=grow)
    rec.wrap(owner, "grow", "test.grow", mutates=True)
    assert owner.grow([0], by=5) == 2
    assert rec.calls == [{"fn": "test.grow", "args": [[0]], "kwargs": {"by": 5}, "result": 2, "args_after": [[0, 5]]}]
