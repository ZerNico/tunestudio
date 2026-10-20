"""Goldens for Tune Studio's port of the chart pipeline: chart a few songs on the ONNX path (what the app runs) and
record every stage function's inputs and outputs, so the app's tests can check each ported function on real data
(apps/studio/electron/charting/goldens.ts, TUNESTUDIO_CHART_GOLDENS). They contain lyrics: never commit them.

Per song, `<out>/<song>/`:
- calls.json.gz: {"song", "opts", "calls"}, one record per call: function, arguments, result, and for functions that
  change their arguments in place, the arguments afterwards. The function names are the format's, from the PoC this
  pipeline was first written in ("autotuner.chart.build_song", "Game.extract", ...).
- arrays/<key>.bin: the large arrays as raw little-endian data, referenced from calls.json as {"$array": key}; the key
  is "<dtype>-<shape>-<hash>" (the pitch track, syllable-start probabilities, emissions, audio windows). Floats that
  JSON can't hold are {"$float": "nan" | "inf" | "-inf"}.
- arrays.json: names for some arrays: the pitch track (track.times, track.midi, track.rms) and the decoded audio
  (audio.vocals16k: the vocals at 16 kHz for pitch and aligner, audio.mix22k: the song at 22.05 kHz for beats).
- chart.txt: the chart.

The model-independent caches (stems, pitch, beats, lyrics) come from an earlier ONNX evaluation run of the song, and
the chart is checked against that run's; the alignment runs again so its steps are recorded too.
"""

import dataclasses
import gzip
import hashlib
import json
import math
import shutil
from pathlib import Path

import numpy as np

from tunestudio_training import chain, evaluate, library
from tunestudio_training.pipeline import (
    align,
    beats,
    boundary,
    chart,
    ends,
    game,
    load_track,
    lyrics,
    notefix,
    onnx_models,
    pitch,
    ultrastar,
)
from tunestudio_training.pipeline.audio import load

BIG = 64  # arrays with more elements than this go to arrays/


class Recorder:
    def __init__(self):
        self.calls: list[dict] = []
        self.arrays: dict[str, np.ndarray] = {}

    def array(self, a: np.ndarray) -> dict:
        a = np.ascontiguousarray(a)
        key = f"{a.dtype}-{'x'.join(map(str, a.shape))}-{hashlib.sha1(a.tobytes()).hexdigest()[:16]}"
        self.arrays.setdefault(key, a)
        return {"$array": key}

    def plain(self, x):
        """JSON-safe copy of a value (dataclasses with their type name, big arrays by reference)."""
        import torch

        if isinstance(x, torch.Tensor):
            x = x.detach().cpu().numpy()
        if isinstance(x, np.ndarray):
            return self.array(x) if x.size > BIG else self.plain(x.tolist())
        if isinstance(x, (np.floating, float)):
            x = float(x)
            return x if math.isfinite(x) else {"$float": "nan" if math.isnan(x) else ("inf" if x > 0 else "-inf")}
        if isinstance(x, np.integer):
            return int(x)
        if isinstance(x, np.bool_):
            return bool(x)
        if dataclasses.is_dataclass(x) and not isinstance(x, type):
            return {
                "$type": type(x).__name__,
                **{f.name: self.plain(getattr(x, f.name)) for f in dataclasses.fields(x)},
            }
        if isinstance(x, dict):
            return {str(k): self.plain(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)):
            return [self.plain(v) for v in x]
        if isinstance(x, (frozenset, set)):
            return {"$set": sorted(self.plain(v) for v in x)}
        if isinstance(x, Path):
            return str(x)
        if x is None or isinstance(x, (bool, int, str)):
            return x
        if isinstance(x, game.Game):
            return {"$type": "Game"}
        if isinstance(x, ultrastar.Song):
            return {"$type": "Song", "text": ultrastar.write(x)}
        return {"$repr": repr(x)[:200]}

    def wrap(self, owner, name: str, label: str, mutates: bool = False) -> None:
        fn = getattr(owner, name)

        def wrapper(*args, **kwargs):
            # Arguments as they were passed: plain() copies them before the call can change them.
            entry = {"fn": label, "args": self.plain(list(args)), "kwargs": self.plain(kwargs)}
            self.calls.append(entry)
            result = fn(*args, **kwargs)
            entry["result"] = self.plain(result)
            if mutates:
                entry["args_after"] = self.plain(list(args))
            return result

        setattr(owner, name, wrapper)


def install(rec: Recorder) -> None:
    import ctc_forced_aligner

    from tunestudio_training import pipeline

    for name in ("preprocess_text", "get_alignments", "get_spans"):
        rec.wrap(ctc_forced_aligner, name, f"ctc_forced_aligner.{name}")
    stages = [
        (align, "_align_tokens", False),
        (align, "pull_in_edges", True),
        (align, "snap_to_voice", True),
        (pipeline, "_align_stage", False),
        (lyrics, "syllabify", False),
        (chart, "syllable_spans", False),
        (boundary, "assign", False),
        (chart, "make_grid", False),
        (chart, "tuning_offset", False),
        (chart, "estimate_scale", False),
        (chart, "notes_for_line_game", False),
        (notefix, "features", False),
        (notefix, "apply", True),
        (ends, "apply", True),
        (chart, "_harmonics", False),
        (chart, "fix_octaves", True),
        (chart, "mark_golden", True),
        (chart, "split_lines", False),
        (chart, "line_breaks", False),
        (chart, "build_song", False),
    ]
    for module, name, mutates in stages:
        rec.wrap(module, name, f"autotuner.{module.__name__.rsplit('.', 1)[-1]}.{name}", mutates)
    rec.wrap(beats.Beats, "fit_grid", "Beats.fit_grid")
    rec.wrap(game.Game, "extract", "Game.extract")


def dump(songs: list[str], cached_run: Path, out: Path, work_root: Path, options: dict) -> None:
    if not onnx_models.folder():
        raise SystemExit("set TST_ONNX: the goldens are for the ONNX path Tune Studio runs")
    info = cached_run / "run.json"
    if info.exists() and not json.loads(info.read_text()).get("onnx"):
        raise SystemExit(f"{cached_run} isn't an ONNX run: the goldens need its ONNX caches (tst eval ... --onnx)")
    for song in songs:
        chain.require(
            cached_run / song, f"{song} in the cached run", f"tst eval <split> <name> --onnx {onnx_models.folder()}"
        )
    rec = Recorder()
    install(rec)
    for song in songs:
        work = work_root / song
        shutil.rmtree(work, ignore_errors=True)
        ignore = shutil.ignore_patterns("scores.json", "*.txt", "align-*.json", "lrc_offset.json")
        shutil.copytree(cached_run / song, work, ignore=ignore)
        rec.calls, rec.arrays = [], {}
        evaluate.chart_song(library.folder(song), work_root, options)
        track = load_track(work)
        _, mix = library.find_files(library.folder(song))
        named = {
            "track.times": track.times,
            "track.midi": track.midi,
            "track.rms": track.rms,
            "audio.vocals16k": load(str(work / "vocals.flac"), pitch.SR).astype(np.float32),
            "audio.mix22k": load(str(mix), beats.SR).astype(np.float32),
        }
        keys = {name: rec.array(a)["$array"] for name, a in named.items()}
        folder = out / song
        folder.mkdir(parents=True, exist_ok=True)
        with gzip.open(folder / "calls.json.gz", "wt", encoding="utf-8") as f:
            json.dump({"song": song, "opts": options, "calls": rec.calls}, f, ensure_ascii=False, allow_nan=False)
        shutil.rmtree(folder / "arrays", ignore_errors=True)
        (folder / "arrays").mkdir()
        for key, a in rec.arrays.items():
            a.astype(a.dtype.newbyteorder("<"), copy=False).tofile(folder / "arrays" / f"{key}.bin")
        (folder / "arrays.json").write_text(json.dumps(keys, indent=1))
        chart_txt = work / f"{song}.txt"
        shutil.copy(chart_txt, folder / "chart.txt")
        counts: dict[str, int] = {}
        for c in rec.calls:
            counts[c["fn"]] = counts.get(c["fn"], 0) + 1
        print(song, counts, flush=True)
        scored = next((cached_run / song).glob("*.txt"), None)
        if scored:  # the recorded run must be the measured one
            print("  chart identical to the cached run's:", scored.read_text() == chart_txt.read_text(), flush=True)
