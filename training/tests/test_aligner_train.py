"""The aligner and boundary-head training loops on a tiny random Wav2Vec2 (32 wide, one layer) and a few synthetic
clips: offline, on the CPU, in seconds."""

import json
import random

import numpy as np
import pytest
import soundfile as sf
import torch

from tunestudio_training import aligner, chain

from conftest import sine

VOCAB = {"<blank>": 0, "<pad>": 1, "<unk>": 2, "a": 3, "b": 4, "c": 5}
SR = 16000


def make_tiny_model(folder):
    """A random Wav2Vec2ForCTC with MMS's layout (stable layer norm, no dropout or masking) and 20 ms frames."""
    from transformers import Wav2Vec2Config, Wav2Vec2CTCTokenizer, Wav2Vec2ForCTC

    folder.mkdir()
    (folder / "vocab.json").write_text(json.dumps(VOCAB))
    tokenizer = Wav2Vec2CTCTokenizer(
        str(folder / "vocab.json"), unk_token="<unk>", pad_token="<pad>", word_delimiter_token=None
    )
    config = Wav2Vec2Config(
        vocab_size=len(VOCAB), hidden_size=32, num_hidden_layers=1, num_attention_heads=2, intermediate_size=64,
        conv_dim=(32, 32), conv_stride=(5, 64), conv_kernel=(10, 64), num_conv_pos_embeddings=16,
        num_conv_pos_embedding_groups=2, do_stable_layer_norm=True, feat_extract_norm="layer",
        hidden_dropout=0.0, activation_dropout=0.0, attention_dropout=0.0, feat_proj_dropout=0.0, final_dropout=0.0,
        layerdrop=0.0, mask_time_prob=0.0, mask_feature_prob=0.0, pad_token_id=0,
    )  # fmt: skip
    torch.manual_seed(0)
    Wav2Vec2ForCTC(config).save_pretrained(folder)
    tokenizer.save_pretrained(folder)
    return folder


def make_tiny_clips(tmp_path):
    """The tiny model, and clips, CTC targets and syllable starts for train (12 clips) and valid (4)."""
    tiny_model = make_tiny_model(tmp_path / "tiny")
    rng = random.Random(0)
    targets, starts = {"model": str(tiny_model)}, {}
    for subset, n in (("train", 12), ("valid", 4)):
        folder = chain.clips_dir() / subset / "waveforms"
        folder.mkdir(parents=True)
        items, bounds = [], []
        for i in range(n):
            name = f"clip-{i:03d}"
            seconds = rng.uniform(0.6, 1.6)
            sf.write(folder / f"{name}.wav", sine(seconds, 220 + 40 * i, SR), SR)
            ids = [rng.choice([3, 4, 5]) for _ in range(rng.randint(2, 5))]
            items.append({"name": name, "text": "x", "ids": ids})
            bounds.append({"name": name, "starts": [round(x, 3) for x in np.linspace(0.1, seconds - 0.2, 3)]})
        (chain.clips_dir() / subset / "index.txt").write_text("".join(f"{x['name']}\n" for x in items))
        targets[subset], starts[subset] = items, bounds
    chain.aligner_data().mkdir(parents=True)
    chain.targets_path().write_text(json.dumps(targets))
    chain.boundaries_path().write_text(json.dumps(starts))
    return tiny_model


@pytest.fixture
def tiny_clips(tmp_path):
    return make_tiny_clips(tmp_path)


def losses(out: str) -> list[float]:
    """The training loss of every logged step."""
    lines = [line for line in out.splitlines() if line.startswith("step ") and "/" in line.split(":")[0]]
    return [float(line.split("loss ")[1].split()[0]) for line in lines]


def test_batches_cap_cover_and_repeat():
    lengths = [1.0, 5.0, 2.0, 2.0, 3.0, 9.0, 0.5]
    a = aligner._batches(lengths, 10, True, random.Random(0))
    b = aligner._batches(lengths, 10, True, random.Random(0))
    assert a == b
    assert sorted(i for batch in a for i in batch) == list(range(len(lengths)))
    for batch in a:
        assert len(batch) == 1 or max(lengths[i] for i in batch) * len(batch) <= 10
    assert aligner._batches(lengths, 10, False, random.Random(0))[0] == [6, 0, 2, 3]  # shortest first


def test_target_and_audio_batch():
    t = aligner._target([0.1], 20)
    assert int(t.argmax()) == 5 and t[5] == 1.0 and 0 < t[4] < 1
    x, mask = aligner._audio_batch([torch.ones(3), torch.ones(5)], "cpu")
    assert x.shape == (2, 5) and mask.tolist() == [[1, 1, 1, 0, 0], [1, 1, 1, 1, 1]]


def _state(path):
    from transformers import Wav2Vec2ForCTC

    return Wav2Vec2ForCTC.from_pretrained(path).state_dict()


def _equal(a, b) -> bool:
    return a.keys() == b.keys() and all(torch.equal(a[k], b[k]) for k in a)


def test_train_aligner_runs_and_repeats(tiny_clips, tmp_path, capsys):
    for k in (1, 2):
        aligner.train_aligner(tmp_path / f"run{k}", steps=4, lr=1e-3, max_seconds=4, device="cpu", seed=0)
    out = capsys.readouterr().out
    assert "step 0: valid loss" in out and "done, best valid loss" in out
    assert _equal(_state(tmp_path / "run1"), _state(tmp_path / "run2"))
    info = json.loads((tmp_path / "run1" / "train_info.json").read_text())
    assert info["step"] == 4 and info["base"] == str(tiny_clips) and info["device"] == "cpu" and info["seed"] == 0
    assert "done, best valid loss" in (tmp_path / "run1" / "train.log").read_text()
    assert not (tmp_path / "run1" / ".resume.pt").exists()


def test_micro_batches_split_a_batch_and_keep_it():
    lengths = [1.0, 1.0, 2.0, 2.0, 2.0, 3.0]
    assert aligner._micro_batches([0, 1, 2, 3, 4, 5], lengths, None) == [[0, 1, 2, 3, 4, 5]]
    assert aligner._micro_batches([0, 1, 2, 3, 4, 5], lengths, 4.5) == [[0, 1], [2, 3], [4], [5]]
    assert aligner._micro_batches([5], lengths, 1.0) == [[5]]  # a clip longer than a micro-batch still runs


def test_micro_batches_give_the_whole_batch_gradients(tiny_clips):
    """The loss and gradients of a batch run as micro-batches equal those of one pass. The model runs in float64, but
    transformers computes the CTC loss in float32, so they agree to float32 rounding (1e-7), not further."""
    from transformers import Wav2Vec2ForCTC

    data = json.loads(chain.targets_path().read_text())
    root = chain.clips_dir() / "train" / "waveforms"
    lengths = [aligner.sf.info(str(root / f"{it['name']}.wav")).duration for it in data["train"]]
    idx = sorted(range(len(lengths)), key=lambda i: lengths[i])
    model = Wav2Vec2ForCTC.from_pretrained(tiny_clips, ctc_loss_reduction="mean", ctc_zero_infinity=True).double()
    model.freeze_feature_encoder()
    real_collate = aligner._collate

    def collate64(*a):
        x, mask, labels = real_collate(*a)
        return x.double(), mask, labels

    grads = []
    for micro in (None, 3.0):
        model.zero_grad()
        aligner._collate = collate64
        try:
            loss = aligner._batch_loss(model, data["train"], idx, lengths, root, "cpu", micro, True)
        finally:
            aligner._collate = real_collate
        grads.append((loss, [p.grad.clone() for p in model.parameters() if p.grad is not None]))
    (full, g_full), (acc, g_acc) = grads
    assert len(aligner._micro_batches(idx, lengths, 3.0)) > 2
    assert acc == pytest.approx(full, rel=1e-6)
    for a, b in zip(g_full, g_acc):
        torch.testing.assert_close(a, b, rtol=1e-5, atol=1e-7)


def test_training_in_micro_batches_matches(tiny_clips, tmp_path):
    aligner.train_aligner(tmp_path / "full", steps=3, lr=1e-3, max_seconds=4, device="cpu", micro_seconds=None)
    aligner.train_aligner(tmp_path / "micro", steps=3, lr=1e-3, max_seconds=4, device="cpu", micro_seconds=1.7)
    a, b = _state(tmp_path / "full"), _state(tmp_path / "micro")
    for k in a:
        torch.testing.assert_close(a[k], b[k], rtol=1e-4, atol=1e-6)
    assert json.loads((tmp_path / "micro" / "train_info.json").read_text())["micro_seconds"] == 1.7


def test_resume_gives_the_same_model(tiny_clips, tmp_path, monkeypatch):
    kw = {"steps": 8, "lr": 1e-3, "max_seconds": 4, "device": "cpu", "validate_every": 3}
    aligner.train_aligner(tmp_path / "straight", **kw)
    real_step, calls = torch.optim.AdamW.step, []

    def stop_at_five(self, *a, **k):
        calls.append(1)
        if len(calls) == 5:
            raise KeyboardInterrupt
        return real_step(self, *a, **k)

    monkeypatch.setattr(torch.optim.AdamW, "step", stop_at_five)
    with pytest.raises(KeyboardInterrupt):
        aligner.train_aligner(tmp_path / "resumed", **kw)
    monkeypatch.setattr(torch.optim.AdamW, "step", real_step)
    assert (tmp_path / "resumed" / ".resume.pt").exists()
    aligner.train_aligner(tmp_path / "resumed", resume=True, **kw)
    assert "resumed at step 3" in (tmp_path / "resumed" / "train.log").read_text()
    assert _equal(_state(tmp_path / "straight"), _state(tmp_path / "resumed"))


def test_train_boundary_runs_and_repeats(tiny_clips, tmp_path, capsys):
    for k in (1, 2):
        aligner.train_boundary(tiny_clips, tmp_path / f"b{k}.pt", steps=3, lr=1e-3, batch=4, device="cpu", seed=0)
    a = torch.load(tmp_path / "b1.pt", weights_only=False)
    b = torch.load(tmp_path / "b2.pt", weights_only=False)
    assert a["backbone"] == "tiny" and a["dim"] == 32 and a["step"] == 3
    assert _equal(a["state"], b["state"])
    assert "±80ms" in capsys.readouterr().out
    assert "saved" in (tmp_path / "b1.log").read_text()
