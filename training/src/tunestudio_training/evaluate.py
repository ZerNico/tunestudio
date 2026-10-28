"""Evaluation runs and paired comparisons, the way every shipped model was judged.

`run` charts every song of a split with the full pipeline (LRCLIB lyrics, the chart's text as fallback) and scores it
against the hand-made chart: `<TST_RUNS>/eval/<split>/<name>/<song>/scores.json`, plus run.json. Stages that don't
depend on the model under test (stems, beats, lyrics, alignment) are shared between the runs of a split, so two runs
differ only where their models do. One process per song (torch memory grows in long-lived processes); resumable.

`compare` pairs two runs' songs and reports per metric the medians, the median per-song difference, a 95% bootstrap
CI of the mean difference and the songs better / worse. A change counts as real if the CI excludes 0 and the mean
difference is at least MIN_EFFECT (re-exporting the same weights already moves metrics by up to ~0.01), with no
language clearly worse. Primary metrics: frame_f1, note_f1, pitch_exact.
"""

import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import zlib
from datetime import datetime
from pathlib import Path

import numpy as np

from tunestudio_training import chain, library, metrics, paths, progress, recipes, splits
from tunestudio_training.pipeline import LyricLine, align, game, load_track, lrclib, lyrics, onnx_models, ultrastar
from tunestudio_training.pipeline import run as chart_pipeline
from tunestudio_training.pipeline.audio import load

METRICS = (
    "frame_f1", "note_f1", "pitch_exact", "combined", "onset_f1", "syllable_f1", "note_f1_off", "note_count_ratio",
    "pitch_within1", "recall", "precision", "golden_f1", "golden_precision", "golden_recall", "golden_count_ratio",
)  # fmt: skip
# frame_f1 replaced combined on 2026-10-09: combined only counts covered reference note time, so it rewards notes
# that run on past where charters end them (learned note ends: combined -0.11, everything else better).
PRIMARY = ("frame_f1", "note_f1", "pitch_exact")
MIN_EFFECT = 0.01
STEMS = ("vocals.flac", "pitch.npz")
SHARED = ("beats.npz", "lrclib.json", "whisper.json")


def chart_lines(song: ultrastar.Song) -> list[LyricLine]:
    """The chart's own lyrics, one line per chart line, without times."""
    groups: dict[int, list[lyrics.Word]] = {}
    for w in lyrics.words_from_song(song):
        groups.setdefault(w.line, []).append(w)
    return [
        LyricLine(re.sub(r"\s+", " ", " ".join(w.text.replace("~", "") for w in words)).strip())
        for words in groups.values()
    ]


def _transcript(work: Path) -> list[LyricLine] | None:
    """A Whisper transcript of the vocals cached in the work dir (whisper.json, made by the PoC's runs), without
    empty segments and repetition loops (they compress far better than lyrics do)."""
    cache = work / "whisper.json"
    if not cache.exists():
        return None
    segments = [LyricLine(s["text"], s["start"], s["end"]) for s in json.loads(cache.read_text())["segments"]]

    def looping(text: str) -> bool:
        raw = text.encode()
        return len(raw) > 40 and len(zlib.compress(raw)) / len(raw) < 0.35

    return [s for s in segments if re.search(r"\w", s.text) and not looping(s.text)]


def _words(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text).lower().replace("’", "'")
    return re.findall(r"[\w']+", text)


def _wer(ref: list[str], hyp: list[str]) -> float:
    """Word error rate of `hyp` against `ref` (edit distance over words / len(ref))."""
    if not ref:
        return 0.0 if not hyp else 1.0
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return prev[-1] / len(ref)


def lrclib_lines(ref: ultrastar.Song, audio: Path, work: Path, heard: list[LyricLine] | None) -> list[LyricLine] | None:
    """LRCLIB's lyrics for the song (cached as lrclib.json). With a transcript (`heard`), the version whose text agrees
    with it best among all versions within a minute of the recording's length (dev: lyric WER 0.192 -> 0.178);
    without, the closest length within 4 s. Other versions' timings come along as alternatives for the alignment."""
    duration = len(load(str(audio), 8000)) / 8000
    artist, title = ref.headers.get("ARTIST", ""), ref.headers.get("TITLE", "")
    if heard:
        said = _words(" ".join(s.text for s in heard))
        found = lrclib.versions(artist, title, duration, work / "lrclib.json")
        synced = min(found, key=lambda v: _wer(said, _words(" ".join(x.text for x in v))), default=None)
    else:
        synced = lrclib.search(artist, title, duration, work / "lrclib.json")
    if not synced:
        return None

    # Versions differ in punctuation, a title line, a repeated chorus: lines are matched by text, unmatched get NaN.
    def key(line) -> str:
        return re.sub(r"\W", "", line.text.lower())

    alts = []
    for v in lrclib.versions(artist, title, duration, work / "lrclib.json"):
        if [line.start for line in v] == [line.start for line in synced]:
            continue
        starts = [float("nan")] * len(synced)
        sm = difflib.SequenceMatcher(None, [key(x) for x in synced], [key(x) for x in v], autojunk=False)
        for a, b, size in sm.get_matching_blocks():
            for k in range(size):
                starts[a + k] = v[b + k].start
        if sum(np.isfinite(starts)) >= 0.5 * len(synced):
            alts.append(starts)
    return [LyricLine(line.text, line.start, alt_starts=tuple(v[i] for v in alts)) for i, line in enumerate(synced)]


def chart_song(folder: Path, out_root: Path, options: dict) -> dict:
    """Chart a library song from its audio and lyrics (LRCLIB, else a cached transcript, else the chart's text) into
    `<out_root>/<song>/`, and score it against the hand-made chart."""
    txt, audio = library.find_files(folder)
    ref = ultrastar.parse(txt)
    language = ref.headers.get("LANGUAGE", "English").split(",")[0].strip()
    work = out_root / folder.name
    work.mkdir(parents=True, exist_ok=True)
    headers = {k: ref.headers[k] for k in ("TITLE", "ARTIST", "YEAR", "GENRE") if k in ref.headers}
    heard = _transcript(work)
    lines, source = lrclib_lines(ref, audio, work, heard), "lrclib"
    if lines is None and heard:
        lines, source = heard, "whisper"
    if lines is None:
        lines, source = chart_lines(ref), "chart (no lrclib match)"
    result = chart_pipeline(str(audio), lines, language, work, headers, options)
    ultrastar.write(result.song, work / f"{folder.name}.txt")
    offset = metrics.reference_offset(ref, load_track(work))
    scores = metrics.compare(metrics.shifted(ref, offset), result.song).row()
    row = {"song": folder.name, "language": language, "lyrics": source, "ref_offset": offset, **scores}
    row["timings"] = result.timings
    (work / "scores.json").write_text(json.dumps(row, indent=2))
    return row


def _prepare(work: Path, siblings: list[Path], onnx: bool) -> bool:
    """Link the stems and copy the model-independent caches into a fresh work dir. False if the song has no stems."""
    stem = library.stems(work.name)
    if stem is None:
        return False
    work.mkdir(parents=True, exist_ok=True)
    # ONNX runs make their own pitch track (shared between ONNX runs like the other caches below).
    for f in STEMS[:1] if onnx else STEMS:
        if not (work / f).exists():
            (work / f).symlink_to((stem / f).resolve())
    # Lyrics fetched by earlier runs: no network needed for those songs.
    for old in [stem, *siblings]:
        f = old / "lrclib.json"
        if f.exists() and not (work / f.name).exists():
            shutil.copy(f, work / f.name)
    for sib in siblings:
        # ONNX runs share beats and alignments only with other ONNX runs, the lyrics side with every run.
        sib_run = sib.parent / "run.json"
        if onnx != bool(sib_run.exists() and json.loads(sib_run.read_text()).get("onnx")):
            if (sib / "whisper.json").exists() and not (work / "whisper.json").exists():
                shutil.copy(sib / "whisper.json", work / "whisper.json")
            continue
        caches = [sib / n for n in SHARED + (("pitch.npz",) if onnx else ())]
        for f in caches + list(sib.glob("align-*.json")) + list(sib.glob("lrc_offset.json")):
            if f.exists() and not (work / f.name).exists():
                shutil.copy(f, work / f.name)
    return True


def _check_models(options: dict, onnx: Path | None) -> None:
    """Everything a run needs, checked once before the per-song processes start (else every song fails alike)."""
    from tunestudio_training.pipeline import default_learned

    game_dir = game.model_dir(options.get("game_model"))
    chain.require(
        game_dir / "config.json",
        "GAME's ONNX models",
        f"unzip openvpi's {recipes.GAME} release into {paths.models() / 'game'}/ (or set TST_GAME, --game)",
    )
    if onnx:
        for repo in ("tunestudio-aligner", "tunestudio-note-refiners", "fcpe-onnx", "beat-this-onnx"):
            chain.require(onnx / repo, f"the {repo} export", f"tst export all --out {onnx}")
        return
    chain.require(Path(align.model_path()) / "config.json", "the aligner", "tst train aligner, or set TST_ALIGNER")
    opts = {**default_learned(), **options}
    for key, model in (("notefix", "notefix"), ("boundary_model", "boundary"), ("ends_model", "ends")):
        if opts.get(key):
            chain.require(Path(opts[key]), f"the {model} checkpoint", f"tst train {model} <name>")


def run(split: str, name: str, options: dict, limit: int | None = None, part: str | None = None) -> None:
    """Chart and score every song of a split; `part` "i/n" takes every n-th song from i (n processes on one run)."""
    songs = progress.select(splits.songs(split)[:limit], part)
    onnx = onnx_models.folder()
    _check_models(options, onnx)
    root = chain.run_dir(split, name)
    root.mkdir(parents=True, exist_ok=True)
    info = {
        "split": split,
        "name": name,
        "options": options,
        "started": datetime.now().isoformat(timespec="seconds"),
        "lyrics": "lrclib, chart text as fallback",
        "onnx": str(onnx) if onnx else None,
        # what actually runs: the defaults the options don't override
        "aligner": Path(align.model_path()).name,
        "game": str(game.model_dir(options.get("game_model"))),
    }
    (root / "run.json").write_text(json.dumps(info, indent=2))
    todo = [s for s in songs if not (root / s / "scores.json").exists()]
    if len(todo) < len(songs):
        print(f"{len(songs) - len(todo)} of {len(songs)} songs scored already", flush=True)
    bar = progress.Progress(len(todo))
    for i, song in enumerate(todo):
        work = root / song
        # Only finished songs of other runs: a run working on the same song may still be writing its caches.
        siblings = [d / song for d in root.parent.iterdir() if d != root and (d / song / "scores.json").exists()]
        if not _prepare(work, siblings, bool(onnx)):
            bar.done(i, song, "no stems yet")
            continue
        start = time.time()
        args = [sys.executable, "-m", "tunestudio_training.evaluate", str(library.folder(song)), str(root)]
        r = subprocess.run([*args, json.dumps(options)], capture_output=True, text=True, env=os.environ)
        # ONNX Runtime can crash while the process shuts down, after the results are written.
        ok = (work / "scores.json").exists()
        bar.done(i, song, "ok" if ok else progress.failure(work, r.stderr), time.time() - start)
    if todo:
        bar.summary()
    info["finished"] = datetime.now().isoformat(timespec="seconds")
    info["songs_scored"] = sum((root / s / "scores.json").exists() for s in songs)
    (root / "run.json").write_text(json.dumps(info, indent=2))


def _scores(split: str, name: str) -> dict[str, dict]:
    root = chain.run_dir(split, name)
    found = {p.parent.name: json.loads(p.read_text()) for p in root.glob("*/scores.json")}
    if not found:
        raise chain.Missing(f"scored songs of the run {split}/{name}", root, f"tst eval {split} {name}")
    return found


def _report(a: dict, b: dict, songs: list[str], rng: np.random.Generator) -> None:
    print(f"{'metric':18s} {'A':>7s} {'B':>7s} {'Δ median':>9s} {'Δ mean 95% CI':>20s} {'B better/worse':>15s}")
    for m in METRICS:
        if any(m not in a[s] or m not in b[s] for s in songs):
            continue
        va = np.array([a[s][m] for s in songs], float)
        vb = np.array([b[s][m] for s in songs], float)
        # The golden metrics are NaN for songs they can't judge (no golden notes in the chart): paired songs only.
        ok = np.isfinite(va) & np.isfinite(vb)
        if not ok.any():
            continue
        va, vb = va[ok], vb[ok]
        d = vb - va
        boot = rng.choice(d, size=(10_000, len(d)), replace=True).mean(axis=1)
        lo, hi = np.percentile(boot, [2.5, 97.5])
        mark = " *" if (lo > 0 or hi < 0) and abs(d.mean()) >= MIN_EFFECT else ""
        flag = "  <- primary" if m in PRIMARY else (f"  ({ok.sum()} songs)" if not ok.all() else "")
        print(
            f"{m:18s} {np.median(va):7.3f} {np.median(vb):7.3f} {np.median(d):+9.3f} "
            f"   [{lo:+.3f}, {hi:+.3f}]{mark:2s} {int(np.sum(d > 0.005)):6d}/{int(np.sum(d < -0.005)):<6d}{flag}"
        )


def compare(split: str, name_a: str, name_b: str, by_language: bool = False) -> None:
    a, b = _scores(split, name_a), _scores(split, name_b)
    songs = sorted(set(a) & set(b))
    if not songs:
        raise SystemExit(f"{name_a} and {name_b} have no scored song in common")
    missing = sorted((set(a) | set(b)) - set(songs))
    print(
        f"{split}: {name_a} (A) vs {name_b} (B), {len(songs)} songs paired"
        + (f", {len(missing)} unpaired" if missing else "")
    )
    rng = np.random.default_rng(0)
    _report(a, b, songs, rng)
    print(f"* = 95% CI excludes 0 and |mean Δ| >= {MIN_EFFECT}")
    if by_language:
        for lang in sorted({b[s].get("language", "?") for s in songs}):
            sub = [s for s in songs if b[s].get("language") == lang]
            if len(sub) >= 5:
                print(f"\n{lang} ({len(sub)} songs)")
                _report(a, b, sub, rng)


if __name__ == "__main__":  # one song of a run, in its own process (see `run`)
    chart_song(Path(sys.argv[1]), Path(sys.argv[2]), json.loads(sys.argv[3]))
