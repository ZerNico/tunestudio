import pytest
import torch

from tunestudio_training import device


def _have(monkeypatch, cuda: bool, mps: bool):
    monkeypatch.setattr(device, "available", lambda: {"cuda": cuda, "mps": mps, "cpu": True})


def test_auto_is_cuda_else_cpu_never_mps(monkeypatch):
    _have(monkeypatch, cuda=True, mps=False)
    assert device.training_device() == "cuda"
    _have(monkeypatch, cuda=False, mps=True)
    assert device.training_device() == "cpu"
    assert device.training_device("mps") == "mps"


def test_setting_and_flag(monkeypatch):
    _have(monkeypatch, cuda=False, mps=True)
    monkeypatch.setenv("TST_DEVICE", "mps")
    assert device.training_device() == "mps"
    assert device.training_device("cpu") == "cpu"


def test_unavailable_devices_say_why(monkeypatch):
    _have(monkeypatch, cuda=False, mps=False)
    with pytest.raises(SystemExit, match="--device cuda: not available"):
        device.training_device("cuda")
    with pytest.raises(SystemExit, match="Apple Silicon"):
        device.training_device("mps")
    with pytest.raises(SystemExit, match="unknown device"):
        device.training_device("tpu")


@pytest.mark.parametrize(
    "name, dev_type, enabled", [("cuda", "cuda", True), ("cpu", "cpu", False), ("mps", "cpu", False)]
)
def test_autocast_is_bf16_only_on_cuda(monkeypatch, name, dev_type, enabled):
    seen = []
    monkeypatch.setattr(device.torch, "autocast", lambda *a, **k: seen.append((a, k)))
    device.autocast(name)
    assert seen == [((dev_type,), {"dtype": torch.bfloat16, "enabled": enabled})]


def test_seed_makes_weights_repeat():
    device.seed(3)
    a = torch.nn.Linear(4, 4).weight.detach().clone()
    device.seed(3)
    assert torch.equal(a, torch.nn.Linear(4, 4).weight)


def _memory(monkeypatch, total, free, mps_cap=None):
    monkeypatch.setattr(device, "memory_gb", lambda: total)
    monkeypatch.setattr(device, "available_gb", lambda: free)
    if mps_cap is not None:
        monkeypatch.setattr(device.torch.mps, "recommended_max_memory", lambda: mps_cap * 2**30)
        monkeypatch.setattr(device.torch.mps, "driver_allocated_memory", lambda: 0)


@pytest.mark.parametrize(
    "free, micro", [(30.0, None), (10.0, 60.0), (8.2, 30.0), (7.6, 20.0), (7.3, 15.0), (2.0, 15.0)]
)
def test_micro_batches_follow_free_memory(monkeypatch, free, micro):
    _memory(monkeypatch, total=24, free=free, mps_cap=17.8)
    plan = device.memory_plan("mps", 120)
    assert plan["micro_seconds"] == micro and plan["checkpointing"] and plan["free_gb"] == min(free, 17.8)


def test_memory_plan_on_cuda_and_big_machines(monkeypatch):
    _memory(monkeypatch, total=24, free=1.0)
    assert device.memory_plan("cuda", 120) == {"micro_seconds": None, "checkpointing": False, "free_gb": None}
    _memory(monkeypatch, total=64, free=40.0)
    assert device.memory_plan("cpu", 120)["checkpointing"] is False
    _memory(monkeypatch, total=None, free=None)  # Linux and Windows: today's path
    assert device.memory_plan("cpu", 120)["micro_seconds"] is None


def test_micro_batch_override(monkeypatch):
    _memory(monkeypatch, total=24, free=30.0, mps_cap=17.8)
    assert device.memory_plan("mps", 120, 20)["micro_seconds"] == 20
    assert device.memory_plan("mps", 120, 200)["micro_seconds"] is None


def test_available_gb_reads_vm_stat():
    import platform

    free = device.available_gb()
    assert (free is None) == (platform.system() != "Darwin")
    assert free is None or 0 < free < (device.memory_gb() or 1e9)
