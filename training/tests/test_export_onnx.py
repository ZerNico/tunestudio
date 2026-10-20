"""The property the byte-identical exports rest on: exporting the same weights twice writes the same bytes."""

import torch

from tunestudio_training import export
from tunestudio_training.pipeline.boundary import Head


def _export(path):
    torch.manual_seed(0)
    model = export.Boundary(Head(1024, 192)).eval()
    torch.onnx.export(
        model,
        (torch.zeros(1, 50, 1024),),
        path,
        input_names=["hidden"],
        output_names=["probs"],
        dynamic_axes={"hidden": {1: "frames"}, "probs": {1: "frames"}},
        opset_version=17,
        dynamo=False,
    )
    return path.read_bytes()


def test_boundary_export_is_deterministic(tmp_path):
    assert _export(tmp_path / "a.onnx") == _export(tmp_path / "b.onnx")
