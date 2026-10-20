"""The tunestudio-note-refiners models: the pitch corrector (notefix) and the note-end regressor (ends), small
scikit-learn gradient-boosted trees over per-note features (pipeline/notefix.py, pipeline/ends.py).

Both learn from the pipeline's own notes on the train songs: an evaluation run with "dump_notes" writes every note's
features before any correction (`tst eval train dump --dump-notes`), and `dataset` labels them against the hand-made
charts: the chart's pitch over most of the note (notefix), and where a hand-made note starts within ±ONSET_HIT of
ours, how much earlier or later it ends (ends). Shipped: nf4 and e3, from 2,627 train songs (1,229,604 notes: 835,436
with a pitch label, 902,572 with a hand-made start).
"""

import json
import pickle
from pathlib import Path

import numpy as np

from tunestudio_training import chain, library, metrics
from tunestudio_training.pipeline import ends, load_track, notefix, ultrastar

ONSET_HIT = 0.08


def dataset_path() -> Path:
    return chain.notes_path()


def dataset(runs: list[Path], out: Path) -> None:
    """Label the dumped notes (notes.json) of every song of the given evaluation runs."""
    for run in runs:
        chain.require(run, "the evaluation run with dumped notes", "tst eval train dump --dump-notes")
        if not any(run.glob("*/notes.json")):
            raise chain.Missing(
                f"dumped notes (notes.json) in {run.name}", run, f"tst eval <split> {run.name} --dump-notes"
            )
    X, y, ref_pitch, song_ids, songs = [], [], [], [], []
    all_x, all_start, all_end, all_hit, all_song, all_end_delta = [], [], [], [], [], []
    for work in sorted(d for run in runs for d in run.iterdir() if (d / "notes.json").exists()):
        chart_file = library.chart(work.name)
        if chart_file is None:
            continue
        si = len(songs)
        songs.append(work.name)
        track = load_track(work)
        ref = ultrastar.parse(chart_file)
        ref = metrics.shifted(ref, metrics.reference_offset(ref, track))
        notes = json.loads((work / "notes.json").read_text())
        end = max([ref.beat_to_sec(x.start + x.length) for x in ref.notes()] + [nt["end"] for nt in notes]) + 5
        rf = metrics._frames(ref, int(end / metrics.HOP))
        ref_notes = sorted(metrics._note_list(ref))
        ref_on = np.array([on for on, *_ in ref_notes])
        rows = 0
        for nt in notes:
            all_x.append(nt["x"])
            all_start.append(nt["start"])
            all_end.append(nt["end"])
            k = int(np.argmin(np.abs(ref_on - nt["start"]))) if len(ref_on) else -1
            hit = k >= 0 and abs(ref_on[k] - nt["start"]) <= ONSET_HIT
            all_hit.append(bool(hit))
            all_end_delta.append(ref_notes[k][1] - nt["end"] if hit else np.nan)
            all_song.append(si)
            a, b = int(nt["start"] / metrics.HOP), int(nt["end"] / metrics.HOP)
            seg = rf[a:b]
            seg = seg[~np.isnan(seg)]
            if b <= a or len(seg) < 0.5 * (b - a):
                continue  # mostly outside the hand-made notes: no pitch label
            vals, counts = np.unique(seg, return_counts=True)
            target = int(vals[np.argmax(counts)])
            X.append(nt["x"])
            y.append(notefix.delta(nt["midi"], target))
            ref_pitch.append(target)
            song_ids.append(si)
            rows += 1
        print(f"[{si + 1}] {work.name}: {rows}/{len(notes)} notes labelled", flush=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out, X=np.array(X, np.float32), y=np.array(y, np.int8), ref=np.array(ref_pitch, np.int16),
        song=np.array(song_ids, np.int32), feature_names=np.array(notefix.FEATURES), songs=np.array(songs),
        all_X=np.array(all_x, np.float32), all_start=np.array(all_start, np.float32),
        all_end=np.array(all_end, np.float32), all_hit=np.array(all_hit, bool), all_song=np.array(all_song, np.int32),
        all_end_delta=np.array(all_end_delta, np.float32),
    )  # fmt: skip
    print(json.dumps({"rows": len(y), "songs": len(songs), "out": str(out)}))


def _held_out(song: np.ndarray) -> np.ndarray:
    """15% of the songs (grouped, so no song is in both parts), for the report; the saved model sees all."""
    rng = np.random.default_rng(0)
    songs = np.unique(song)
    held = rng.choice(songs, size=max(1, int(0.15 * len(songs))), replace=False)
    return np.isin(song, held)


def train_notefix(data: Path, out: Path) -> None:
    """Reports, per confidence threshold, how many held-out notes the model would change and whether the hand-made
    pitch class match goes up. The dev split is judged with the full pipeline (`tst eval` with {"notefix": out})."""
    from sklearn.ensemble import HistGradientBoostingClassifier

    d = np.load(chain.require(data, "the notes dataset", "tst dataset notes"))
    X, song = d["X"], d["song"]
    y = d["y"].astype(int)
    y = np.where(np.isin(y, notefix.CLASSES), y, 0)  # larger shifts count as "keep"
    te = _held_out(song)
    print(f"{len(y)} notes from {len(np.unique(song))} songs; held out {te.sum()} notes")
    print("label distribution:", {int(c): f"{np.mean(y == c):.1%}" for c in notefix.CLASSES})

    def fit(Xf, yf):
        return HistGradientBoostingClassifier(
            max_iter=400, learning_rate=0.05, max_leaf_nodes=31, l2_regularization=1.0, random_state=0
        ).fit(Xf, yf)

    clf = fit(X[~te], y[~te])
    proba = clf.predict_proba(X[te])
    k = proba.argmax(1)
    pred, conf = np.array(clf.classes_)[k], proba[np.arange(len(k)), k]
    base = np.mean(y[te] == 0)
    print(f"held-out: our pitch matches the chart on {base:.1%} of notes")
    for thr in (0.4, 0.5, 0.6, 0.7, 0.8):
        change = (pred != 0) & (conf >= thr)
        after = np.where(change, pred, 0) == y[te]
        right = np.mean(y[te][change] == pred[change]) if change.any() else 0
        print(
            f"  threshold {thr}: change {change.mean():.1%} of notes, right {right:.1%} of those, "
            f"match {after.mean():.1%} ({after.mean() - base:+.1%})"
        )
    _save(fit(X, y), out)


def end_rows(d) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(features, target, song) of the notes with a hand-made note starting within ±ONSET_HIT: target = hand-made end
    - our end in seconds, clipped to ±0.5."""
    X, starts, stops, delta, song = d["all_X"], d["all_start"], d["all_end"], d["all_end_delta"], d["all_song"]
    feats, target, songs = [], [], []
    for s in np.unique(song):
        idx = np.where(song == s)[0]
        F = ends.features(X[idx].tolist(), starts[idx].tolist(), stops[idx].tolist())
        ok = np.isfinite(delta[idx])
        feats.append(F[ok])
        target.append(np.clip(delta[idx][ok], -0.5, 0.5))
        songs.append(np.full(ok.sum(), s))
    return np.concatenate(feats), np.concatenate(target), np.concatenate(songs)


def train_ends(data: Path, out: Path) -> None:
    """Reports the held-out end error unchanged, with one fixed shift (the median) and with the model, plus the share
    of ends within ±100 ms (what note_f1_off counts)."""
    from sklearn.ensemble import HistGradientBoostingRegressor

    X, y, song = end_rows(np.load(chain.require(data, "the notes dataset", "tst dataset notes")))
    te = _held_out(song)
    print(f"{len(y)} notes from {len(np.unique(song))} songs; held out {te.sum()}; median target {np.median(y):+.3f}s")

    def fit(Xf, yf):
        return HistGradientBoostingRegressor(
            loss="absolute_error", max_iter=400, learning_rate=0.05, max_leaf_nodes=31, l2_regularization=1.0,
            random_state=0,
        ).fit(Xf, yf)  # fmt: skip

    reg = fit(X[~te], y[~te])
    shift = np.median(y[~te])
    for label, err in (
        ("unchanged", y[te]),
        (f"fixed {shift:+.3f}s", y[te] - shift),
        ("model", y[te] - reg.predict(X[te])),
    ):
        print(f"  {label:16s} MAE {np.mean(np.abs(err)) * 1000:.0f}ms, within ±100ms {np.mean(np.abs(err) <= 0.1):.1%}")
    _save(fit(X, y), out)


def _save(model, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "wb") as f:
        pickle.dump(model, f)
    print("saved", out)
