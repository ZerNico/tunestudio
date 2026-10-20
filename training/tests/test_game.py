import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper

from tunestudio_training.pipeline import game


def test_segmenter_noise_becomes_an_input(tmp_path):
    x = helper.make_tensor_value_info("x", TensorProto.FLOAT, ["B", "T"])
    y = helper.make_tensor_value_info("y", TensorProto.FLOAT, ["B", "T"])
    nodes = [
        helper.make_node("RandomUniformLike", ["x"], ["r"]),
        helper.make_node("Add", ["x", "r"], ["y"]),
    ]
    model = helper.make_model(helper.make_graph(nodes, "g", [x], [y]), opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    onnx.save(model, tmp_path / "segmenter.onnx")
    patched = onnx.load_from_string(game._segmenter_with_noise_input(tmp_path / "segmenter.onnx"))
    assert [n.op_type for n in patched.graph.node] == ["Add"]
    assert [i.name for i in patched.graph.input] == ["x", game.NOISE]
    s = ort.InferenceSession(patched.SerializeToString(), providers=["CPUExecutionProvider"])
    a = np.ones((1, 3), np.float32)
    noise = np.array([[0.1, 0.2, 0.3]], np.float32)
    np.testing.assert_allclose(s.run(None, {"x": a, game.NOISE: noise})[0], a + noise)
