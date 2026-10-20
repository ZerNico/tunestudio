"""Line clips: the training data of the aligner and the boundary head. One clip per chart line, the vocal stem cut
from LEAD seconds before the line's first note to TAIL seconds after its last one, at 44.1 kHz, the chart shifted by
its measured offset to this audio (metrics.reference_offset).

train songs -> `<TST_DATA>/clips/train`, dev songs -> `clips/valid` (every VALID_EVERY-th line: validation only needs a
sample to pick checkpoints). Test songs are never written. Skipped:
- lines with rap/freestyle notes, lines over 20 s;
- broken lines: the singer's pitch agrees with the chart (±1 semitone, octave-agnostic) on less than MIN_AGREE of the
  voiced note time, or less than MIN_VOICED of the note time is voiced at all. Loose on purpose: it should drop wrong
  timing or missing vocals, not bias the data towards "chart = sung pitch".

Each subset has waveforms/<clip>.wav, index.txt (clip names) and songs.json (every song with its chart's sha1 and
line count, plus the splits manifest's sha1), so a model records exactly what it was trained on. build.json says what
the build was asked for: a `limit` build is a smoke test, and training refuses it unless told otherwise.
"""

import hashlib
import json
import shutil
from collections import Counter
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path

import numpy as np
import soundfile as sf

from tunestudio_training import chain, library, metrics, splits
from tunestudio_training.pipeline import load_track, ultrastar
from tunestudio_training.pipeline.audio import load
from tunestudio_training.pipeline.pitch import PitchTrack

SR = 44100
LEAD, TAIL = 0.2, 0.3
MIN_AGREE, MIN_VOICED = 0.35, 0.4
VALID_EVERY = 4


def folder() -> Path:
    return chain.clips_dir()


def clip_name(song: str, line: int) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in f"{song}-{line:03d}")


def shifted_chart(song: str, track: PitchTrack) -> ultrastar.Song:
    """The song's hand-made chart, shifted onto our audio."""
    chart = ultrastar.parse(library.chart(song))
    return metrics.shifted(chart, metrics.reference_offset(chart, track))


def line_quality(spans: list[tuple[float, float, int]], track: PitchTrack) -> tuple[float, float]:
    """(share of note time with a voiced frame, share of voiced note time within ±1 semitone of the chart)."""
    voiced = agree = total = 0
    for s, e, midi in spans:
        frames = track.slice(s, e)
        total += len(frames)
        v = frames[~np.isnan(frames)]
        voiced += len(v)
        d = np.abs(v - midi) % 12
        agree += int(np.sum(np.minimum(d, 12 - d) <= 1))
    return voiced / max(total, 1), agree / max(voiced, 1)


def song_clips(song: str, work: Path, stats: Counter) -> Iterator[tuple[str, np.ndarray]]:
    track = load_track(work)
    chart = shifted_chart(song, track)
    audio = load(str(work / "vocals.flac"), SR)
    for li, phrase in enumerate(chart.voices[0]):
        stats["lines"] += 1
        if not phrase or any(n.type not in ("normal", "golden") for n in phrase):
            stats["skip: rap/freestyle"] += 1
            continue
        spans = [(chart.beat_to_sec(n.start), chart.beat_to_sec(n.start + n.length), n.midi) for n in phrase]
        a, b = max(0.0, spans[0][0] - LEAD), spans[-1][1] + TAIL
        if b * SR > len(audio) or b - a > 20:
            stats["skip: too long / past end"] += 1
            continue
        voiced, agree = line_quality(spans, track)
        if voiced < MIN_VOICED or agree < MIN_AGREE:
            stats["skip: broken (no voice / timing)"] += 1
            continue
        # The clip's length as the sum of its notes and rests, overlapping and empty notes left out.
        durs, t = [], a
        for s, e, _ in spans:
            if s > t + 0.005:
                durs.append(s - t)
            elif s < t:
                s = t
            if e - s <= 0.005:
                continue
            durs.append(e - s)
            t = e
        durs.append(b - t)
        stats["lines kept"] += 1
        yield clip_name(song, li), audio[int(a * SR) : int(a * SR) + int(round(sum(durs) * SR))]


def _write_subset(out: Path, songs: list[str], every: int = 1) -> dict:
    (out / "waveforms").mkdir(parents=True, exist_ok=True)
    stats, names, record = Counter(), [], {}
    for song in songs:
        work = library.stems(song)
        if work is None:
            stats["songs without stems"] += 1
            continue
        try:
            items = list(song_clips(song, work, stats))[::every]
        except Exception as e:  # noqa: BLE001
            print(f"skip {song}: {e!r}")
            stats["songs failed"] += 1
            continue
        stats["songs"] += 1
        record[song] = {"sha1": hashlib.sha1(library.chart(song).read_bytes()).hexdigest(), "lines": len(items)}
        for name, chunk in items:
            sf.write(out / "waveforms" / f"{name}.wav", chunk, SR)
            names.append(name)
            stats["seconds"] += len(chunk) / SR
    (out / "index.txt").write_text("".join(f"{n}\n" for n in names))
    manifest_sha1 = hashlib.sha1(splits.manifest_path().read_bytes()).hexdigest()
    (out / "songs.json").write_text(
        json.dumps({"splits_manifest_sha1": manifest_sha1, "songs": record}, indent=1, ensure_ascii=False)
    )
    stats["hours"] = round(stats.pop("seconds", 0) / 3600, 2)
    return dict(stats)


def build(original: bool = True, limit: int | None = None) -> None:
    """`original`: only the train songs of the first split (what the shipped aligner and boundary head saw)."""
    splits.check_disjoint()
    train, dev = splits.songs("train", original)[:limit], splits.songs("dev")[:limit]
    for name, songs in (("train", train), ("dev", dev)):
        missing = sum(library.stems(s) is None for s in songs)
        if missing:
            print(f"{missing:,}/{len(songs):,} {name} songs have no stems and are left out (tst stems {name})")
    out = folder()
    if out.exists():
        shutil.rmtree(out)
    stats = {
        "train": _write_subset(out / "train", train),
        "valid": _write_subset(out / "valid", dev, VALID_EVERY),
    }
    stats["filters"] = {"min_agree": MIN_AGREE, "min_voiced": MIN_VOICED, "lead": LEAD, "tail": TAIL}
    (out / "stats.json").write_text(json.dumps(stats, indent=2))
    build = {
        "original": original,
        "limit": limit,
        "splits_manifest_sha1": chain.manifest_sha1(),
        "time": datetime.now().isoformat(timespec="seconds"),
    }
    (out / "build.json").write_text(json.dumps(build, indent=1) + "\n")
    print(json.dumps(stats, indent=2))


def names(subset: str) -> list[str]:
    return [n for n in (folder() / subset / "index.txt").read_text().split("\n") if n]
