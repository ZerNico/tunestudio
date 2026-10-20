import json
import os
import time

import pytest

from tunestudio_training import chain, paths


def test_require_and_missing(tmp_path):
    assert chain.require(tmp_path, "x") == tmp_path
    with pytest.raises(chain.Missing) as e:
        chain.require(tmp_path / "nope", "the thing", "tst make thing")
    assert str(e.value) == f"the thing not found at {tmp_path / 'nope'}\n  make it with: tst make thing"


def test_checkpoint_names():
    m = paths.models()
    assert chain.checkpoint("aligner", "ft3") == m / "aligner" / "ft3"
    assert chain.checkpoint("boundary", "b2") == m / "boundary" / "b2.pt"
    assert chain.checkpoint("notefix", "nf5") == m / "notefix" / "nf5.pkl"
    assert chain.checkpoint("ends", "/abs/e.pkl") == chain.Path("/abs/e.pkl")


def _clips(build: dict | None = None) -> None:
    for subset in ("train", "valid"):
        (chain.clips_dir() / subset).mkdir(parents=True, exist_ok=True)
        (chain.clips_dir() / subset / "index.txt").write_text("a\n")
    if build is not None:
        (chain.clips_dir() / "build.json").write_text(json.dumps(build))


def test_clip_states():
    assert chain.STEPS["clips"].state() == "missing"
    with pytest.raises(chain.Missing, match="tst dataset clips"):
        chain.require_step("clips")
    _clips()
    assert chain.STEPS["clips"].state() == "ok"  # made before build.json: nothing to object to
    _clips({"limit": 20, "splits_manifest_sha1": chain.manifest_sha1()})
    assert chain.STEPS["clips"].state() == "stale: a smoke build (--limit 20)"
    _clips({"limit": None, "splits_manifest_sha1": "other"})
    assert "other splits" in chain.STEPS["clips"].state()
    _clips({"limit": None, "splits_manifest_sha1": chain.manifest_sha1()})
    assert chain.STEPS["clips"].state() == "ok"


def test_targets_older_than_clips_are_stale():
    _clips()
    chain.aligner_data().mkdir(parents=True)
    chain.targets_path().write_text("{}")
    past = time.time() - 100
    os.utime(chain.targets_path(), (past, past))
    assert chain.STEPS["targets"].state() == "stale: older than the clips"
    assert chain.STEPS["boundaries"].state() == "missing"


def test_dump_needs_notes():
    run = chain.dump_run()
    (run / "S").mkdir(parents=True)
    assert chain.STEPS["dump"].state() == "missing"
    (run / "S" / "notes.json").write_text("[]")
    assert chain.STEPS["dump"].state() == "ok"


def test_verify_export(tmp_path):
    out = tmp_path / "export"
    assert "missing: tunestudio-aligner/aligner.onnx" in chain.verify_export(out)
    assert not [p for p in chain.verify_export(out) if "README" in p]  # cards may change
    lic = out / "fcpe-onnx" / "LICENSE"
    lic.parent.mkdir(parents=True)
    lic.write_bytes((paths.MODEL_CARDS / "fcpe-onnx" / "LICENSE").read_bytes())
    assert not [p for p in chain.verify_export(out, ("fcpe-onnx",)) if "LICENSE" in p]
    lic.write_text("changed")
    assert "differs from the shipped file: fcpe-onnx/LICENSE" in chain.verify_export(out, ("fcpe-onnx",))
    (out / "fcpe-onnx" / "README.md").write_text("new card")
    assert chain.changed_cards(out, ("fcpe-onnx",)) == ["fcpe-onnx/README.md"]
