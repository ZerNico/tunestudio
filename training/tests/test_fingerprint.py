import gzip
import json
import time

import numpy as np

from tunestudio_training import fingerprint


def test_content_not_container(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    for root in (a, b):
        root.mkdir()
        np.savez_compressed(root / "x.npz", v=np.arange(5), w=np.ones(3, np.float32))
        with gzip.open(root / "c.json.gz", "wt") as f:
            f.write('{"k": 1}')
        time.sleep(1.1 if root is a else 0)  # different zip and gzip timestamps
    (a / "d.json").write_text('{"b": 1, "a": [1, 2]}')
    (b / "d.json").write_text('{\n "a": [1, 2],\n "b": 1\n}')
    (a / "build.json").write_text("1")
    fa, fb = fingerprint.fingerprint([a]), fingerprint.fingerprint([b])
    assert fa == fb and set(fa["x.npz"]) == {"v", "w"}


def test_compare_names_arrays(tmp_path, capsys):
    np.savez(tmp_path / "x.npz", v=np.arange(5), w=np.ones(3))
    saved = tmp_path / "fp.json"
    assert fingerprint.main([str(tmp_path / "x.npz"), "--save", str(saved)]) == 0
    np.savez(tmp_path / "x.npz", v=np.arange(5), w=np.zeros(3))
    assert fingerprint.main([str(tmp_path / "x.npz"), "--compare", str(saved)]) == 1
    assert "differs: x.npz (arrays w)" in capsys.readouterr().out
    assert json.loads(saved.read_text())["x.npz"]["v"]
