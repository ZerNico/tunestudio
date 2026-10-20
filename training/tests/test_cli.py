import json
import subprocess
import sys

import pytest

from tunestudio_training import chain, cli, paths, recipes

COMMANDS = [
    [], ["init"], ["status"], ["doctor"], ["splits"], ["stems"], ["dataset"], ["train"], ["train", "aligner"],
    ["train", "boundary"], ["train", "notefix"], ["train", "ends"], ["rebuild"], ["eval"], ["compare"], ["export"],
    ["goldens"], ["syllables"], ["fixtures"], ["fingerprint"],
]  # fmt: skip


def test_every_help_works_without_torch():
    """`--help` of every command, in one process that must not import torch (or anything heavy)."""
    code = (
        "import sys, contextlib, io\n"
        "from tunestudio_training import cli\n"
        f"for args in {COMMANDS!r}:\n"
        "    with contextlib.redirect_stdout(io.StringIO()) as out:\n"
        "        try:\n"
        "            cli.main([*args, '--help'])\n"
        "        except SystemExit as e:\n"
        "            assert e.code == 0, args\n"
        "    assert 'usage: tst' in out.getvalue(), args\n"
        "heavy = [m for m in ('torch', 'transformers', 'onnxruntime', 'sklearn') if m in sys.modules]\n"
        "assert not heavy, heavy\n"
    )
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_help_shows_the_recipe(capsys):
    with pytest.raises(SystemExit):
        cli.main(["train", "--help"])
    assert f"{recipes.ALIGNER.steps} steps at lr {recipes.ALIGNER.lr:g}" in capsys.readouterr().out


def _calls(monkeypatch, module, name):
    seen = []
    monkeypatch.setattr(module, name, lambda *a, **k: seen.append((a, k)))
    return seen


def test_dataset_clips_dispatch(monkeypatch):
    from tunestudio_training import clips

    seen = _calls(monkeypatch, clips, "build")
    cli.main(["dataset", "clips", "--all", "--limit", "3"])
    assert seen == [((), {"original": False, "limit": 3})]


def test_eval_dispatch(monkeypatch, tmp_path):
    from tunestudio_training import evaluate

    seen = _calls(monkeypatch, evaluate, "run")
    (tmp_path / "o.json").write_text('{"notefix": null}')
    cli.main(
        ["eval", "dev", "x", "--options", f"@{tmp_path / 'o.json'}", "--game", "g", "--dump-notes", "--part", "1/2"]
    )
    (split, name, options, limit, part), _ = seen[0]
    assert (split, name, limit, part) == ("dev", "x", None, "1/2")
    assert options == {"notefix": None, "game_model": str((paths.Path.cwd() / "g").resolve()), "dump_notes": True}


def test_train_defaults_come_from_the_recipe(monkeypatch):
    from tunestudio_training import rebuild

    seen = _calls(monkeypatch, rebuild, "train")
    cli.main(["train", "aligner", "ft3"])
    cli.main(["train", "boundary", "b2", "--backbone", "ft3", "--steps", "10"])
    cli.main(["train", "notefix", "nf5"])
    assert seen[0] == (("aligner", "ft3"), {"force": False, "seed": 0, "allow_smoke": False, "resume": False})
    assert seen[1][1]["backbone"] == "ft3" and seen[1][1]["steps"] == 10
    assert seen[2] == (("notefix", "nf5"), {"force": False})


def test_missing_prerequisite_exits_2_with_the_command(capsys):
    with pytest.raises(SystemExit) as e:
        cli.main(["dataset", "aligner"])
    assert e.value.code == 2
    err = capsys.readouterr().err
    assert err.startswith("error: the line clips not found at") and "make it with: tst dataset clips" in err


def test_train_refuses_to_overwrite(capsys):
    (paths.models() / "notefix").mkdir(parents=True)
    (paths.models() / "notefix" / "nf4.pkl").write_bytes(b"")
    with pytest.raises(SystemExit, match="nf4 is the shipped notefix"):
        cli.main(["train", "notefix", "nf4"])


def test_train_refuses_smoke_clips():
    for subset in ("train", "valid"):
        (chain.clips_dir() / subset).mkdir(parents=True)
        (chain.clips_dir() / subset / "index.txt").write_text("a\n")
    (chain.clips_dir() / "build.json").write_text(
        json.dumps({"limit": 5, "splits_manifest_sha1": chain.manifest_sha1()})
    )
    with pytest.raises(SystemExit, match="smoke build"):
        cli.main(["train", "aligner", "x"])


@pytest.mark.parametrize("bad", ["2/2", "x", "1"])
def test_part_is_checked(bad, capsys):
    with pytest.raises(SystemExit) as e:
        cli.main(["stems", "train", "--part", bad])
    assert e.value.code == 2 and "--part" in capsys.readouterr().err


def test_config_flag(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("TST_RUNS")
    cfg = tmp_path / "other.toml"
    cfg.write_text('[paths]\nruns = "elsewhere"\n')
    from tunestudio_training import status

    monkeypatch.setattr(status, "status", lambda verify: print(paths.runs()))
    cli.main(["--config", str(cfg), "status"])
    assert capsys.readouterr().out.strip() == str(tmp_path / "elsewhere")


def test_init_and_rebuild_dry_run(tmp_path, tiny_splits, capsys, monkeypatch):
    tiny_splits({"train": ["A - 1"], "dev": ["B - 1"]}, manifest={"A - 1": {"split": "train"}})
    for key in ("TST_DATA", "TST_LIBRARY", "TST_MODELS", "TST_RUNS"):
        monkeypatch.delenv(key)
    monkeypatch.setenv("TST_CONFIG", str(tmp_path / "new.toml"))
    monkeypatch.chdir(tmp_path)
    cli.main(["init", "--library", "songs", "--data", "d"])
    assert paths.data() == tmp_path / "d"
    capsys.readouterr()
    cli.main(["rebuild", "aligner", "ft3", "--dry-run"])
    out = capsys.readouterr().out
    assert "stems: 2 of 2 songs missing" in out and "clips: build" in out and "targets: make" in out
    assert f"TST_ALIGNER={paths.models() / 'aligner' / 'ft3'} tst eval dev ft3" in out
