import os
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

from tunestudio_training import config, paths


def _write(tmp_path: Path, text: str) -> Path:
    cfg = Path(os.environ["TST_CONFIG"])
    cfg.write_text(text)
    config.cache_clear()
    return cfg


def test_variable_beats_file_beats_default(tmp_path, monkeypatch):
    monkeypatch.delenv("TST_DATA")
    assert config.lookup("paths.data") == (config.LOCAL / "data", "default")
    cfg = _write(tmp_path, '[paths]\ndata = "/from/file"\n')
    assert config.lookup("paths.data") == (Path("/from/file"), cfg.name)
    monkeypatch.setenv("TST_DATA", "/from/env")
    assert config.lookup("paths.data") == (Path("/from/env"), "TST_DATA")


def test_empty_variable_counts_as_unset(tmp_path, monkeypatch):
    monkeypatch.setenv("TST_DATA", "")
    _write(tmp_path, '[paths]\ndata = "/from/file"\n')
    assert paths.data() == Path("/from/file")


def test_relative_paths_are_relative_to_the_file(tmp_path, monkeypatch):
    for key in ("TST_DATA", "TST_LIBRARY"):
        monkeypatch.delenv(key)
    cfg = _write(tmp_path, '[paths]\ndata = "here/data"\nlibrary = ["songs", "/abs/more"]\n')
    assert paths.data() == cfg.parent / "here" / "data"
    assert paths.library_roots() == [cfg.parent / "songs", Path("/abs/more")]


def test_variable_paths_are_taken_as_given(monkeypatch):
    monkeypatch.setenv("TST_DATA", "relative/data")
    assert paths.data() == Path("relative/data")
    monkeypatch.setenv("TST_DATA", "~/data")
    assert paths.data() == Path.home() / "data"


def test_lists_in_variables_and_files(tmp_path, monkeypatch):
    monkeypatch.setenv("TST_LIBRARY", os.pathsep.join(["/a", "", "~/b"]))
    assert paths.library_roots() == [Path("/a"), Path.home() / "b"]
    monkeypatch.setenv("TST_ORT_PROVIDERS", "CUDAExecutionProvider,CPUExecutionProvider")
    assert paths.ort_providers() == ("CUDAExecutionProvider", "CPUExecutionProvider")
    monkeypatch.delenv("TST_ORT_PROVIDERS")
    _write(tmp_path, '[devices]\nonnx = ["CoreMLExecutionProvider"]\n[paths]\nstems = "/one/folder"\n')
    assert paths.ort_providers() == ("CoreMLExecutionProvider",)
    assert paths.stem_dirs()[1:] == [Path("/one/folder")]


def test_unknown_key_names_it_and_the_valid_ones(tmp_path):
    _write(tmp_path, '[paths]\ndatas = "x"\n')
    with pytest.raises(SystemExit) as e:
        paths.data()
    assert "paths.datas" in str(e.value) and "paths.data" in str(e.value)
    _write(tmp_path, 'library = "x"\n')
    with pytest.raises(SystemExit, match="isn't a section"):
        paths.data()


def test_wrong_types_and_devices(tmp_path, monkeypatch):
    monkeypatch.delenv("TST_RUNS")
    _write(tmp_path, "[paths]\nruns = 3\n")
    with pytest.raises(SystemExit, match="paths.runs must be a path"):
        paths.runs()
    monkeypatch.setenv("TST_DEVICE", "tpu")
    with pytest.raises(SystemExit, match="one of auto, cuda, mps, cpu"):
        config.value("devices.train")


def test_missing_config_file_named_explicitly(tmp_path, monkeypatch):
    monkeypatch.delenv("TST_DATA")
    monkeypatch.setenv("TST_CONFIG", str(tmp_path / "nope.toml"))
    with pytest.raises(SystemExit, match="config file not found"):
        paths.data()


def test_default_config_file_may_be_missing(monkeypatch):
    monkeypatch.delenv("TST_CONFIG")
    monkeypatch.setattr(config, "TRAINING", Path("/nonexistent"))
    config.cache_clear()
    assert config._table() == {}


def test_unknown_variables_are_reported(monkeypatch):
    monkeypatch.setenv("TST_DATAS", "x")
    assert config.unknown_env() == ["TST_DATAS"]


def test_init_writes_a_file_that_reads_back(tmp_path, monkeypatch):
    for key in ("TST_DATA", "TST_LIBRARY", "TST_MODELS", "TST_RUNS"):
        monkeypatch.delenv(key)
    monkeypatch.chdir(tmp_path)
    file = tmp_path / "cfg" / "tst.toml"
    (tmp_path / "cfg").mkdir()
    config.init(file, library=["/music/a", "cfg/songs"], data="cfg/d", stems=["/stems"], train="mps")
    raw = tomllib.loads(file.read_text())
    assert raw["paths"]["library"] == ["/music/a", "songs"]
    assert raw["paths"]["data"] == "d"
    assert raw["paths"]["models"] == ".local/models"
    assert raw["devices"]["train"] == "mps"
    monkeypatch.setenv("TST_CONFIG", str(file))
    config.cache_clear()
    assert paths.library_roots() == [Path("/music/a"), file.parent / "songs"]
    assert paths.data() == file.parent / "d"
    assert paths.models() == file.parent / ".local" / "models"
    assert config.value("devices.train") == "mps"
    with pytest.raises(SystemExit, match="exists already"):
        config.init(file)
    config.init(file, force=True, data='quote"and\\back')
    config.cache_clear()
    assert paths.data() == tmp_path / 'quote"and\\back'


def test_a_subprocess_sees_the_same_values(tmp_path, monkeypatch):
    monkeypatch.delenv("TST_RUNS")
    _write(tmp_path, '[paths]\nruns = "r"\n')
    code = "from tunestudio_training import paths; print(paths.runs(), paths.data())"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.split()
    assert out == [str(tmp_path / "r"), str(paths.data())]
