import os
from pathlib import Path

from tunestudio_training import paths


def test_stem_dirs_start_with_the_data_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("TST_STEMS", os.pathsep.join(["/a", "/b"]))
    assert paths.stem_dirs() == [tmp_path / "data" / "stems", Path("/a"), Path("/b")]


def test_aligner_and_game_follow_the_models_folder(tmp_path, monkeypatch):
    assert paths.aligner() == tmp_path / "models" / "aligner" / "aligner-ft2"
    assert paths.game() == tmp_path / "models" / "game" / "GAME-1.0.3-large-onnx"
    assert paths.ort_providers() == ("CPUExecutionProvider",)
    monkeypatch.setenv("TST_ALIGNER", "/x/aligner-ft3")
    monkeypatch.setenv("TST_GAME", "/x/game")
    assert paths.aligner() == Path("/x/aligner-ft3")
    assert paths.game() == Path("/x/game")


def test_onnx_is_only_a_variable(monkeypatch):
    assert paths.onnx() is None
    monkeypatch.setenv("TST_ONNX", "~/export")
    assert paths.onnx() == Path.home() / "export"


def test_pipeline_reads_the_same_values(tmp_path, monkeypatch):
    from tunestudio_training.pipeline import align, default_learned, game

    assert align.model_path() == str(tmp_path / "models" / "aligner" / "aligner-ft2")
    assert game.model_dir() == tmp_path / "models" / "game" / "GAME-1.0.3-large-onnx"
    assert game.model_dir("/other") == Path("/other")
    assert default_learned() == {
        "notefix": str(tmp_path / "models" / "notefix" / "nf4.pkl"),
        "boundary_model": str(tmp_path / "models" / "boundary" / "b1.pt"),
        "ends_model": str(tmp_path / "models" / "ends" / "e3.pkl"),
    }
    monkeypatch.setenv("TST_ALIGNER", "/x/aligner-ft3")
    assert align.model_path() == "/x/aligner-ft3"
