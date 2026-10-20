"""The tunestudio-aligner models: the MMS CTC aligner fine-tuned on singing, and the syllable-start (boundary) head on
its hidden states. Both learn from the line clips (`clips.py`).

Aligner: MahmoudAshraf/mms-300m-1130-forced-aligner (what ctc-forced-aligner uses), fine-tuned so its emissions fit
singing (held vowels, melismas) instead of speech. Only the text is supervised (CTC targets: each clip's lyrics through
the same steps as at alignment time); the timing is what improves. Audio goes in like at alignment time: raw 16 kHz,
no normalization. The feature encoder stays frozen, the learning rate is small and training short, so the model keeps
its 1130 languages. Shipped: aligner-ft2, lr 6e-5 on a 6000-step cosine schedule, batches of 120 s of padded audio, the
best checkpoint at step 4000 (held-out CTC loss 2.81 -> 0.77; the loss depends on the batching).

Both train on CUDA, MPS or the CPU (device.py). Where memory is short (Apple Silicon, small machines), each batch runs
as micro-batches whose gradients add up to the whole batch's, with gradient checkpointing: the same batches, loss and
updates as on CUDA, only slower (device.memory_plan, recorded in train_info.json).

Boundary head (pipeline/boundary.py): the frozen aligner's last hidden layer -> per 20 ms frame, the probability that a
syllable starts there. Targets: the charts' syllable starts, Gaussian-smoothed (sigma 1 frame) so chart sloppiness of
a frame or two isn't punished hard. Shipped: b1, 4000 steps at lr 1e-3 on aligner-ft2.
"""

import json
import math
import random
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio

from tunestudio_training import chain, clips, library, progress, recipes
from tunestudio_training import device as devices
from tunestudio_training.pipeline import align, load_track, lyrics, ultrastar
from tunestudio_training.pipeline.boundary import FRAME, Head

BASE = recipes.ALIGNER.base
SR = 16000
SUBSETS = (("train", "train"), ("valid", "dev"))


def folder() -> Path:
    return chain.aligner_data()


def _songs(subset: str) -> list[str]:
    return list(json.loads((clips.folder() / subset / "songs.json").read_text())["songs"])


def targets() -> None:
    """CTC targets per clip (`targets.json`): the line's lyrics as aligner token ids, romanized like at alignment time
    (align._parts, ctc_forced_aligner.preprocess_text with uroman)."""
    from ctc_forced_aligner import preprocess_text
    from transformers import AutoTokenizer

    chain.require_step("clips")
    vocab = {
        k.lower(): v for k, v in AutoTokenizer.from_pretrained(BASE, word_delimiter_token=None).get_vocab().items()
    }
    result = {}
    for subset, _ in SUBSETS:
        wanted = set(clips.names(subset))
        items, skipped = [], 0
        for song in _songs(subset):
            if library.chart(song) is None:
                print(f"skip {song}: its chart isn't in the library any more")
                continue
            chart = ultrastar.parse(library.chart(song))
            language = chart.headers.get("LANGUAGE", "English").split(",")[0].strip()
            lang = align.LANGUAGES.get(language.lower(), language.lower()[:3])
            by_line: dict[int, list[str]] = {}
            for w in lyrics.words_from_song(chart):
                by_line.setdefault(w.line, []).append(w.text)
            for li, words in by_line.items():
                name = clips.clip_name(song, li)
                if name not in wanted:
                    continue
                parts = [p for w in words for p in align._parts(w)]
                if not parts:
                    skipped += 1
                    continue
                try:
                    tokens, _ = preprocess_text(" ".join(parts), romanize=True, language=lang, split_size="word")
                except Exception:  # noqa: BLE001
                    skipped += 1
                    continue
                ids = [vocab[c] for c in " ".join(tokens[1::2]).split(" ") if c in vocab]
                if ids:
                    items.append({"name": name, "text": " ".join(parts), "ids": ids})
        result[subset] = items
        print(f"{subset}: {len(items)} clips with targets ({len(wanted)} clips, {skipped} skipped)")
    result["model"] = BASE
    folder().mkdir(parents=True, exist_ok=True)
    (folder() / "targets.json").write_text(json.dumps(result, ensure_ascii=False))
    print("wrote", folder() / "targets.json")


def boundaries() -> None:
    """Syllable-start targets per clip (`boundaries.json`): the line's syllable starts (notes that aren't "~"), in
    seconds from the clip's start."""
    chain.require_step("clips")
    result = {}
    for subset, _ in SUBSETS:
        wanted = set(clips.names(subset))
        items = []
        for song in _songs(subset):
            if library.chart(song) is None or library.stems(song) is None:
                print(f"skip {song}: its chart or stems aren't here any more")
                continue
            chart = clips.shifted_chart(song, load_track(library.stems(song)))
            for li, phrase in enumerate(chart.voices[0]):
                name = clips.clip_name(song, li)
                if name not in wanted or not phrase:
                    continue
                a = max(0.0, chart.beat_to_sec(phrase[0].start) - clips.LEAD)
                starts = [round(chart.beat_to_sec(n.start) - a, 3) for n in phrase if n.text.strip() not in ("~", "")]
                items.append({"name": name, "starts": starts})
        result[subset] = items
        print(f"{subset}: {len(items)} clips ({len(wanted)} in the dataset)", flush=True)
    folder().mkdir(parents=True, exist_ok=True)
    (folder() / "boundaries.json").write_text(json.dumps(result))
    print("wrote", folder() / "boundaries.json")


def load_clip(path: Path) -> torch.Tensor:
    wav, sr = sf.read(str(path), dtype="float32", always_2d=True)
    wav = torch.from_numpy(wav.mean(axis=1))
    return torchaudio.functional.resample(wav, sr, SR) if sr != SR else wav


def _batches(lengths: list[float], max_seconds: float, shuffle: bool, rng: random.Random) -> list[list[int]]:
    """Clips grouped by length into batches of at most `max_seconds` of padded audio."""
    order = sorted(range(len(lengths)), key=lambda i: lengths[i])
    out, cur, cur_max = [], [], 0.0
    for i in order:
        m = max(cur_max, lengths[i])
        if cur and m * (len(cur) + 1) > max_seconds:
            out.append(cur)
            cur, m = [], lengths[i]
        cur.append(i)
        cur_max = m
    if cur:
        out.append(cur)
    if shuffle:
        rng.shuffle(out)
    return out


def _audio_batch(wavs: list[torch.Tensor], device: str) -> tuple[torch.Tensor, torch.Tensor]:
    """Zero-padded audio and its attention mask."""
    n = max(len(w) for w in wavs)
    x = torch.zeros(len(wavs), n)
    mask = torch.zeros(len(wavs), n, dtype=torch.long)
    for k, w in enumerate(wavs):
        x[k, : len(w)] = w
        mask[k, : len(w)] = 1
    return x.to(device), mask.to(device)


def _collate(items: list[dict], idx: list[int], root: Path, device: str):
    x, mask = _audio_batch([load_clip(root / f"{items[i]['name']}.wav") for i in idx], device)
    labels = torch.full((len(idx), max(len(items[i]["ids"]) for i in idx)), -100, dtype=torch.long)
    for k, i in enumerate(idx):
        labels[k, : len(items[i]["ids"])] = torch.tensor(items[i]["ids"])
    return x, mask, labels.to(device)


def _micro_batches(idx: list[int], lengths: list[float], micro_seconds: float | None) -> list[list[int]]:
    """A batch split into consecutive micro-batches of at most `micro_seconds` of padded audio (one clip at least),
    or the whole batch."""
    if not micro_seconds:
        return [idx]
    out, cur = [], []
    for i in idx:
        if cur and max(lengths[j] for j in [*cur, i]) * (len(cur) + 1) > micro_seconds:
            out.append(cur)
            cur = []
        cur.append(i)
    return out + [cur]


def _batch_loss(model, items, idx, lengths, root, dev, micro_seconds, backward: bool) -> float:
    """The batch's CTC loss, exactly as one forward pass over the whole batch computes it: each clip's loss divided by
    its target length (ctc_loss_reduction "mean"), then the mean over the clips. Over micro-batches that is the sum of
    each micro-batch's mean weighted by its share of the clips, and so are the gradients, which `backward` adds up."""
    total = 0.0
    for sub in _micro_batches(idx, lengths, micro_seconds):
        x, mask, labels = _collate(items, sub, root, dev)
        with devices.autocast(dev):
            loss = model(x, attention_mask=mask, labels=labels).loss
        if len(sub) != len(idx):
            loss = loss * (len(sub) / len(idx))
        if backward:
            loss.backward()
        total += float(loss.detach())
    return total


def train_aligner(
    out: Path,
    steps: int = recipes.ALIGNER.steps,
    lr: float = recipes.ALIGNER.lr,
    max_seconds: float = recipes.ALIGNER.batch_seconds,
    device: str | None = None,
    seed: int = 0,
    resume: bool = False,
    log_every: int = 50,
    validate_every: int = recipes.ALIGNER.validate_every,
    micro_seconds: float | None = None,
) -> None:
    """Fine-tune on `targets.json`; saves the best checkpoint (validation CTC loss) as a Hugging Face model dir, its
    output in `train.log` there. `micro_seconds` (default: from the device's memory, devices.memory_plan) splits each
    batch without changing it. `resume` carries on from the state saved at the last validation."""
    from transformers import AutoTokenizer, Wav2Vec2ForCTC

    devices.seed(seed)
    dev = devices.training_device(device)
    data = json.loads(chain.require_step("targets").read_text(encoding="utf8"))
    plan = devices.memory_plan(dev, max_seconds, micro_seconds)
    micro = plan["micro_seconds"]
    out.mkdir(parents=True, exist_ok=True)
    log = progress.Log(out / "train.log")
    tokenizer = AutoTokenizer.from_pretrained(data["model"], word_delimiter_token=None)
    vocab = {k.lower(): v for k, v in tokenizer.get_vocab().items()}
    blank = vocab.get("<blank>", tokenizer.pad_token_id)
    model = Wav2Vec2ForCTC.from_pretrained(
        data["model"], ctc_loss_reduction="mean", ctc_zero_infinity=True, pad_token_id=blank
    )
    model.freeze_feature_encoder()
    if plan["checkpointing"]:
        # Recomputes each layer's activations in the backward pass instead of keeping them: the same gradients (MMS
        # has no dropout), less memory, about a third more time.
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.to(dev).train()
    log(f"blank id {blank}, vocab {len(vocab)}, params {sum(p.numel() for p in model.parameters()) / 1e6:.0f}M")
    log(
        f"device {dev}"
        + (f" ({plan['free_gb']:g} GB free)" if plan["free_gb"] is not None else "")
        + f", batches of {max_seconds:g} s"
        + (f" in micro-batches of {micro:g} s (--micro-batch-seconds)" if micro else "")
        + (", gradient checkpointing" if plan["checkpointing"] else "")
        + f", seed {seed}"
    )

    roots = {k: clips.folder() / k / "waveforms" for k, _ in SUBSETS}
    lengths = {k: [sf.info(str(roots[k] / f"{it['name']}.wav")).duration for it in data[k]] for k, _ in SUBSETS}
    log(f"train {len(data['train'])} lines / {sum(lengths['train']) / 3600:.1f}h, valid {len(data['valid'])}")

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=lr, weight_decay=0.01)
    warmup = max(1, min(300, steps // 10))
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / warmup) * 0.5 * (1 + math.cos(math.pi * min(s, steps) / steps))
    )
    rng = random.Random(0)

    def validate() -> float:
        model.eval()
        losses = []
        with torch.no_grad():
            for idx in _batches(lengths["valid"], max_seconds, False, rng):
                losses.append(
                    _batch_loss(model, data["valid"], idx, lengths["valid"], roots["valid"], dev, micro, False)
                )
        model.train()
        devices.empty_cache(dev)
        return float(np.mean(losses))

    info = {
        "base": data["model"], "lr": lr, "steps": steps, "batch_seconds": max_seconds, "device": dev, "seed": seed,
        "micro_seconds": micro, "gradient_checkpointing": plan["checkpointing"], "free_gb": plan["free_gb"],
        "torch": torch.__version__,
    }  # fmt: skip
    state_file = out / ".resume.pt"
    step, epoch_start, done_in_epoch = 0, rng.getstate(), 0
    if resume and state_file.exists():
        state = torch.load(state_file, map_location="cpu", weights_only=False)
        model.load_state_dict(state["model"])
        opt.load_state_dict(state["opt"])
        sched.load_state_dict(state["sched"])
        step, best, epoch_start, done_in_epoch = state["step"], state["best"], state["epoch_start"], state["batch"]
        rng.setstate(epoch_start)
        log(f"resumed at step {step} (best valid loss {best:.4f})")
    else:
        if resume:
            log(f"nothing to resume in {out}: starting from the beginning")
        best = validate()
        log(f"step 0: valid loss {best:.4f} (base model)")
    batches = _batches(lengths["train"], max_seconds, True, rng)
    eta, t0, start_step = progress.Eta(steps - step), time.time(), step
    while step < steps:
        if done_in_epoch == len(batches):
            epoch_start, done_in_epoch = rng.getstate(), 0
            batches = _batches(lengths["train"], max_seconds, True, rng)
        idx = batches[done_in_epoch]
        done_in_epoch += 1
        opt.zero_grad(set_to_none=True)
        loss = _batch_loss(model, data["train"], idx, lengths["train"], roots["train"], dev, micro, True)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        sched.step()
        step += 1
        if step % log_every == 0:
            pace = (time.time() - t0) / (step - start_step)
            log(
                f"step {step}/{steps}: loss {loss:.4f} lr {sched.get_last_lr()[0]:.2e} ({pace:.2f}s/step"
                f"{eta(step - start_step)}{devices.in_use(dev)})"
            )
        if step % validate_every == 0 or step == steps:
            v = validate()
            log(f"step {step}: valid loss {v:.4f}" + (" (best, saved)" if v < best else ""))
            if v < best:
                best = v
                model.save_pretrained(out)
                tokenizer.save_pretrained(out)
                (out / "train_info.json").write_text(json.dumps({**info, "step": step, "valid_loss": v}))
            if step < steps:
                state = {
                    "model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(), "step": step,
                    "best": best, "epoch_start": epoch_start, "batch": done_in_epoch,
                }  # fmt: skip
                torch.save(state, state_file)
    state_file.unlink(missing_ok=True)
    log(f"done, best valid loss {best:.4f}")


def _target(starts: list[float], n: int, sigma: float = 1.0) -> torch.Tensor:
    t = torch.zeros(n)
    frames = torch.arange(n, dtype=torch.float32)
    for s in starts:
        t = torch.maximum(t, torch.exp(-0.5 * ((frames - s / FRAME) / sigma) ** 2))
    return t


def train_boundary(
    backbone_dir: Path,
    out: Path,
    steps: int = recipes.BOUNDARY.steps,
    lr: float = recipes.BOUNDARY.lr,
    batch: int = recipes.BOUNDARY.batch,
    device: str | None = None,
    seed: int = 0,
    log_every: int = 100,
    evaluate_every: int = recipes.BOUNDARY.evaluate_every,
) -> None:
    """Train the head on `boundaries.json` over a frozen aligner. Reports, on the dev clips, how many chart starts have
    a predicted peak within ±40 ms / ±80 ms at a few thresholds, and keeps the checkpoint with the most within ±80 ms
    at 0.3. Its output also goes to `<name>.log` next to the checkpoint."""
    from transformers import Wav2Vec2ForCTC

    devices.seed(seed)
    dev = devices.training_device(device)
    data = json.loads(chain.require_step("boundaries").read_text())
    log = progress.Log(out.with_suffix(".log"))
    backbone = Wav2Vec2ForCTC.from_pretrained(backbone_dir).to(dev).eval()
    for p in backbone.parameters():
        p.requires_grad = False
    dim, hidden = backbone.config.hidden_size, recipes.BOUNDARY.hidden
    head = Head(dim, hidden).to(dev)
    opt = torch.optim.AdamW(head.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=steps, pct_start=0.05)
    roots = {k: clips.folder() / k / "waveforms" for k, _ in SUBSETS}
    rng = random.Random(0)
    log(f"device {dev}, backbone {Path(backbone_dir).name}, seed {seed}")

    def hidden_batch(items: list[dict], root: Path):
        wavs = [load_clip(root / f"{it['name']}.wav") for it in items]
        x, mask = _audio_batch(wavs, dev)
        with torch.no_grad(), devices.autocast(dev):
            h = backbone.wav2vec2(x, attention_mask=mask).last_hidden_state.float()
        T = h.shape[1]
        lens = [min(T, len(w) // backbone.config.inputs_to_logits_ratio) for w in wavs]
        y = torch.stack([_target(it["starts"], T) for it in items]).to(dev)
        valid = torch.zeros(len(items), T, device=dev)
        for k, ln in enumerate(lens):
            valid[k, :ln] = 1
        return h, y, valid

    def evaluate() -> tuple[float, str]:
        head.eval()
        hits = {(thr, tol): [0, 0] for thr in (0.2, 0.3, 0.5) for tol in (2, 4)}
        extra = {thr: 0 for thr in (0.2, 0.3, 0.5)}
        items = data["valid"]
        with torch.no_grad():
            for i in range(0, len(items), 16):
                chunk = items[i : i + 16]
                h, _, valid = hidden_batch(chunk, roots["valid"])
                p = torch.sigmoid(head(h)).cpu().numpy() * valid.cpu().numpy()
                for k, it in enumerate(chunk):
                    pk = p[k]
                    peaks = [j for j in range(1, len(pk) - 1) if pk[j] >= pk[j - 1] and pk[j] > pk[j + 1]]
                    st = np.array([s / FRAME for s in it["starts"]])
                    for thr in extra:
                        pp = np.array([j for j in peaks if pk[j] >= thr])
                        for tol in (2, 4):
                            hits[(thr, tol)][0] += sum(1 for s in st if len(pp) and np.min(np.abs(pp - s)) <= tol)
                            hits[(thr, tol)][1] += len(st)
                        extra[thr] += sum(1 for j in pp if not len(st) or np.min(np.abs(st - j)) > 4)
        head.train()
        devices.empty_cache(dev)

        def share(thr: float, tol: int) -> float:
            return hits[(thr, tol)][0] / max(hits[(thr, tol)][1], 1)

        report = " | ".join(
            f"thr {thr}: ±40ms {share(thr, 2):.1%} ±80ms {share(thr, 4):.1%} extra peaks {extra[thr]}" for thr in extra
        )
        return share(0.3, 4), report

    eta, t0 = progress.Eta(steps), time.time()
    best = -1.0
    for step in range(1, steps + 1):
        h, y, valid = hidden_batch(rng.sample(data["train"], batch), roots["train"])
        logits = head(h)
        weight = valid * (1 + 9 * y)
        loss = torch.nn.functional.binary_cross_entropy_with_logits(logits, y, weight=weight, reduction="sum")
        loss = loss / valid.sum()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        sched.step()
        if step % log_every == 0:
            pace = (time.time() - t0) / step
            line = f"step {step}/{steps}: loss {float(loss.detach()):.4f} ({pace:.2f}s/step{eta(step)}"
            log(line + f"{devices.in_use(dev)})")
        if step % evaluate_every == 0 or step == steps:
            score, report = evaluate()
            log(f"step {step} valid: {report}")
            score = float(f"{score:.1%}"[:-1])  # the checkpoint is chosen by the share as printed
            if score > best:
                best = score
                ckpt = {"state": head.state_dict(), "dim": dim, "hidden": hidden, "backbone": Path(backbone_dir).name}
                out.parent.mkdir(parents=True, exist_ok=True)
                torch.save({**ckpt, "step": step, "device": dev, "seed": seed}, out)
                log(f"  saved {out}")
