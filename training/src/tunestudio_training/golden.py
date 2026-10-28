"""Golden notes: re-mark the charts of an evaluation run, train the golden-note model, and judge how plausible a
run's golden notes look.

`rescore` copies a run's charts, re-marks their golden notes with pipeline.golden.mark (the `golden` chart option)
and scores them again into a new run of the same split, so `tst compare` can judge a method without charting again.
Golden marking is the last step, so only the golden metrics change (up to the ~0.2% of notes `chart.build_song` cuts
differently when a golden note stops it merging a "~").

`train` learns which of the pipeline's notes charters gild, from every chart of the given runs (the train dump run):
per-note features (pipeline.golden.FEATURES), labelled 1 where the note could match a golden note of the hand-made
chart (the golden metric's criterion, metrics.golden_pairs). sel's songs and every other song of sel's artists stay
out, so sel remains a check. A fifth of the remaining artists is held out for the report, then the model is fitted
again on all of them.

`plausibility` asks whether our golden notes look like a charter's, whatever the exact notes: the style figures
(share of notes, length, last/highest/longest of their line, in runs, spread over the song) of ours next to the
hand-made charts', and how well a classifier tells the two apart (AUC 0.5: not at all).
"""

import copy
import functools
import json
import shutil
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from tunestudio_training import chain, library, metrics, splits
from tunestudio_training.pipeline import chart, golden, load_track, ultrastar

HELD_OUT = 5  # one artist in this many is held out for the training report


def _song(work: Path) -> tuple[ultrastar.Song, ultrastar.Song, dict] | None:
    """(our chart, the hand-made chart lined up with our audio, scores.json) of a run's song."""
    ours, ref = work / f"{work.name}.txt", library.chart(work.name)
    if not (work / "scores.json").exists() or not ours.exists() or ref is None or not (work / "pitch.npz").exists():
        return None
    scores = json.loads((work / "scores.json").read_text())
    return ultrastar.parse(ours), metrics.shifted(ultrastar.parse(ref), scores["ref_offset"]), scores


def _mark(song: ultrastar.Song, work: Path, options: dict) -> None:
    track = load_track(work)
    grid = chart.Grid(song.bpm, song.gap / 1000)
    golden.mark(song.voices[0], grid, track, chart.tuning_offset(track), options)


def rescore(split: str, run: str, name: str, options: dict) -> None:
    """Re-mark the golden notes of run `run`'s charts with `options` into run `name`, and score them."""
    src, dst = chain.run_dir(split, run), chain.run_dir(split, name)
    chain.require(src, f"the evaluation run {split}/{run}", f"tst eval {split} {run}")
    dst.mkdir(parents=True, exist_ok=True)
    done = 0
    for work in sorted(d for d in src.iterdir() if d.is_dir()):
        found = _song(work)
        if found is None:
            continue
        ours, ref, scores = found
        _mark(ours, work, options)
        out = dst / work.name
        out.mkdir(exist_ok=True)
        if not (out / "pitch.npz").exists():
            shutil.copy(work / "pitch.npz", out / "pitch.npz")
        ultrastar.write(ours, out / f"{work.name}.txt")
        row = {**scores, **metrics.compare(ref, ours).row()}
        (out / "scores.json").write_text(json.dumps(row, indent=2))
        done += 1
    info = {"split": split, "name": name, "rescored_from": run, "options": {"golden": options}, "songs_scored": done}
    (dst / "run.json").write_text(json.dumps(info, indent=2))
    print(f"{done} songs of {split}/{run} re-marked into {split}/{name}")


def labels(ref: ultrastar.Song, ours: ultrastar.Song) -> np.ndarray:
    """1 for our sung notes that could match a golden note of the hand-made chart (not one-to-one)."""
    gold = metrics._golden_list(ref)
    out = np.zeros(len(golden.sung_notes(ours.voices[0])), np.int8)
    for k, (_, _, n) in enumerate(golden.sung_notes(ours.voices[0])):
        span = (ours.beat_to_sec(n.start), ours.beat_to_sec(n.start + n.length))
        out[k] = bool(metrics.golden_pairs(gold, [span]))
    return out


def _example(work: Path) -> dict | None:
    """A run's song as training data: features, labels, the song's `structure` (what `pick` needs), and what scoring a
    pick needs (the chart's golden notes, our notes' times, the shipped rule's pick). None for songs that can't be
    used (duet, no chart, no notes)."""
    found = _song(work)
    if found is None or len(found[0].voices) > 1:
        return None
    ours, ref, _ = found
    for n in ours.notes():
        n.type = "normal" if n.type == "golden" else n.type
    lines = ours.voices[0]
    if not golden.sung_notes(lines):
        return None
    track = load_track(work)
    grid, tuning = chart.Grid(ours.bpm, ours.gap / 1000), chart.tuning_offset(track)
    s = golden.structure(lines, grid)
    ruled = copy.deepcopy(lines)
    chart.mark_golden(ruled, grid, track, tuning)
    return {
        "song": work.name,
        "X": golden.features(lines, grid, track, tuning),
        "y": labels(ref, ours),
        "structure": {k: s[k] for k in ("start", "end", "line", "melisma", "text")},
        "ref": metrics._golden_list(ref),
        "spans": list(zip(s["start"].tolist(), s["end"].tolist())),
        "rule": np.array([k for k, (_, _, n) in enumerate(golden.sung_notes(ruled)) if n.type == "golden"], int),
    }


def examples(runs: list[Path], leave_out: set[str] = frozenset()) -> list[dict]:
    """`_example` of every song of the runs except `leave_out`, in parallel."""
    work = [d for run in runs for d in sorted(run.iterdir()) if d.is_dir() and d.name not in leave_out]
    with ProcessPoolExecutor() as pool:
        return [e for e in pool.map(_example, work, chunksize=16) if e is not None]


def golden_f1(example: dict, picked: np.ndarray) -> float:
    """The golden F1 (metrics.golden_scores) of marking `picked` in the example's song, NaN without golden notes in
    the chart."""
    if not example["ref"]:
        return float("nan")
    hits = len(metrics.golden_pairs(example["ref"], [example["spans"][k] for k in picked]))
    return 2 * hits / (len(example["ref"]) + len(picked))


def _f1(songs: list[dict], proba: list[np.ndarray], **pick) -> float:
    return float(np.nanmean([golden_f1(e, golden.pick(p, e["structure"], **pick)) for e, p in zip(songs, proba)]))


def _fit(songs: list[dict], linear: bool):
    """The model fitted on the songs' notes, as pipeline.golden.load_model returns it."""
    X = np.concatenate([e["X"] for e in songs])
    y = np.concatenate([e["y"] for e in songs])
    model = {"features": list(golden.FEATURES), "pick": dict(golden.PICK)}
    if not linear:
        from sklearn.ensemble import HistGradientBoostingClassifier

        trees = HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=200, l2_regularization=1.0,
            random_state=0,
        )  # fmt: skip
        return {**model, "trees": trees.fit(X, y)}
    from sklearn.linear_model import LogisticRegression

    terms = golden.terms()
    T = golden.expand(X, terms)
    mean, scale = T.mean(axis=0), T.std(axis=0)
    scale[scale == 0] = 1.0
    lr = LogisticRegression(C=1.0, max_iter=5000).fit((T - mean) / scale, y)
    return {**model, "terms": terms, "mean": mean.tolist(), "scale": scale.tolist(), "coef": lr.coef_[0].tolist(),
            "intercept": float(lr.intercept_[0])}  # fmt: skip


@functools.cache
def _artists() -> dict[str, str]:
    return {song: info["artist"] for song, info in json.loads(splits.manifest_path().read_text())["songs"].items()}


def artist(song: str) -> str:
    """A song's primary artist from the split manifest (else the folder name's part before " - ")."""
    return _artists().get(song) or song.split(" - ")[0].lower()


def held_out(song: str) -> bool:
    """Whether a train song's artist is in the held-out fifth (by artist, so one voice is on one side only)."""
    return zlib.crc32(artist(song).encode()) % HELD_OUT == 0


def train(runs: list[Path], out: Path, linear: bool = False) -> None:
    """Fit the golden model on the charts of `runs`, report it on held-out train artists, and save it fitted on all:
    `--linear` as the JSON table, else gradient-boosted trees (a pickle, to measure the table against)."""
    from sklearn.metrics import log_loss, roc_auc_score

    for run in runs:
        chain.require(run, "the evaluation run", "tst eval train dump --dump-notes")
    sel = splits.songs("sel")
    sel_artists = {artist(s) for s in sel}
    leave_out = set(sel) | set(splits.songs("dev")) | set(splits.songs("test"))
    songs = [e for e in examples(runs, leave_out) if artist(e["song"]) not in sel_artists]
    fit = [e for e in songs if not held_out(e["song"])]
    ho = [e for e in songs if held_out(e["song"])]
    notes = sum(len(e["y"]) for e in songs)
    gold = sum(int(e["y"].sum()) for e in songs)
    print(f"{len(songs)} songs ({notes} notes, {gold / notes:.1%} golden) without sel and its artists, "
          f"{len(ho)} held out for this report")  # fmt: skip

    model = _fit(fit, linear)
    proba = [golden.probabilities(model, e["X"]) for e in ho]
    y, p = np.concatenate([e["y"] for e in ho]), np.concatenate(proba)
    within = [roc_auc_score(e["y"], q) for e, q in zip(ho, proba) if 0 < e["y"].sum() < len(e["y"])]
    rule = np.nanmean([golden_f1(e, e["rule"]) for e in ho])
    print(f"held out: log loss {log_loss(y, p):.4f}, AUC {roc_auc_score(y, p):.3f}, "
          f"within songs {np.mean(within):.3f}, golden F1 {_f1(ho, proba, **golden.PICK):.3f} "
          f"(the shipped rule {rule:.3f})")  # fmt: skip
    # the first model's pick, a cap on gilded repeats, no spread
    for alt in ({"start": "any", "runs": 1.0, "spread": None}, {"repeat_cap": 3}, {"spread": None}):
        print(f"  with {alt}: golden F1 {_f1(ho, proba, **{**golden.PICK, **alt}):.3f}")

    model = _fit(songs, linear)
    model["trained"] = {"name": out.stem, "runs": [f"{r.parent.name}/{r.name}" for r in runs], "songs": len(songs),
                        "notes": notes}  # fmt: skip
    out.parent.mkdir(parents=True, exist_ok=True)
    if linear:
        out.write_text(json.dumps(model, indent=1))
    else:
        import pickle

        out.write_bytes(pickle.dumps(model))
    print("saved", out)


# --- plausibility ------------------------------------------------------------------------------------------------

STYLE = ("log_sec", "line_last", "line_high", "line_long", "in_run", "song_pos", "rel_pitch", "vs_line")


def style_rows(song: ultrastar.Song) -> tuple[np.ndarray, float, int]:
    """Per golden note of a chart, judged inside that chart: [log10 seconds, last / highest / longest of its line,
    in a run of consecutive golden notes, place in the song, semitones from the song's median note, length / its
    line's median], and the share of sung notes that are golden and how many tenths of the song have one."""
    lines = [[n for n in ln if n.type in ("normal", "golden")] for ln in song.voices[0]]
    lines = [ln for ln in lines if ln]
    notes = [n for ln in lines for n in ln]
    if not notes:
        return np.zeros((0, len(STYLE))), float("nan"), 0
    med = np.median([n.pitch for n in notes])
    t0 = song.beat_to_sec(notes[0].start)
    t1 = max(song.beat_to_sec(notes[-1].start), t0 + 1)
    rows, tenths = [], set()
    for ln in lines:
        lens, pitches = [n.length for n in ln], [n.pitch for n in ln]
        g = [n.type == "golden" for n in ln]
        for k, n in enumerate(ln):
            if not g[k]:
                continue
            sec = song.beat_to_sec(n.start + n.length) - song.beat_to_sec(n.start)
            pos = (song.beat_to_sec(n.start) - t0) / (t1 - t0)
            tenths.add(min(9, int(pos * 10)))
            in_run = (k > 0 and g[k - 1]) or (k + 1 < len(ln) and g[k + 1])
            rows.append([np.log10(max(sec, 0.01)), k == len(ln) - 1, n.pitch == max(pitches), n.length == max(lens),
                         in_run, pos, n.pitch - med, n.length / np.median(lens)])  # fmt: skip
    return np.array(rows, float).reshape(-1, len(STYLE)), len(rows) / len(notes), len(tenths)


def plausibility_scores(pairs: list[tuple[ultrastar.Song, ultrastar.Song]]) -> dict:
    """Style of the hand-made charts' golden notes and of ours, over (hand-made, ours) pairs of songs whose chart has
    golden notes: per figure (theirs, ours), and "c2st", the cross-validated AUC of a logistic regression telling
    our golden notes from theirs by the style rows (grouped by song, 0.5 = indistinguishable)."""
    from scipy.stats import wasserstein_distance
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import GroupKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    theirs, mine, gr, go, share, tenths = [], [], [], [], ([], []), ([], [])
    for i, (ref, ours) in enumerate(pairs):
        for rows, groups, side, song in ((theirs, gr, 0, ref), (mine, go, 1, ours)):
            x, s, t = style_rows(song)
            rows.append(x)
            groups += [i] * len(x)
            share[side].append(s)
            tenths[side].append(t)
    R, O = np.concatenate(theirs), np.concatenate(mine)  # noqa: E741
    out = {
        "share": (float(np.nanmedian(share[0])), float(np.nanmedian(share[1]))),
        "share_w1": float(wasserstein_distance(np.nan_to_num(share[0]), np.nan_to_num(share[1]))),
        "sec": (float(10 ** np.median(R[:, 0])), float(10 ** np.median(O[:, 0])) if len(O) else float("nan")),
    }
    for j, name in ((1, "last"), (2, "highest"), (3, "longest"), (4, "runs")):
        out[name] = (float(R[:, j].mean()), float(O[:, j].mean()) if len(O) else float("nan"))
    out["tenths"] = (float(np.mean(tenths[0])), float(np.mean(tenths[1])))
    out["c2st"] = float("nan")
    if len(O) > 20:
        X, y, g = np.concatenate([R, O]), np.r_[np.zeros(len(R)), np.ones(len(O))], np.r_[gr, go]
        p = np.zeros(len(y))
        clf = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000))
        for a, b in GroupKFold(5).split(X, y, g):
            p[b] = clf.fit(X[a], y[a]).predict_proba(X[b])[:, 1]
        out["c2st"] = float(roc_auc_score(y, p))
    return out


def plausibility(split: str, runs: list[str]) -> None:
    """Print the style figures of each run's golden notes next to the hand-made charts'."""
    print(f"{'run':16s} {'share':>11s} {'sec':>11s} {'last':>11s} {'highest':>11s} {'longest':>11s} {'runs':>11s} "
          f"{'tenths':>11s} {'c2st':>5s}   (hand-made / ours, c2st 0.5 = indistinguishable)")  # fmt: skip
    for run in runs:
        root = chain.run_dir(split, run)
        chain.require(root, f"the evaluation run {split}/{run}", f"tst eval {split} {run}")
        pairs = []
        for work in sorted(d for d in root.iterdir() if (d / "scores.json").exists()):
            ref = library.chart(work.name)
            if ref is None or not (work / f"{work.name}.txt").exists():
                continue
            offset = json.loads((work / "scores.json").read_text())["ref_offset"]
            ref = metrics.shifted(ultrastar.parse(ref), offset)
            ours = ultrastar.parse(work / f"{work.name}.txt")
            if len(ours.voices) == 1 and len(ref.voices) == 1 and metrics._golden_list(ref):
                pairs.append((ref, ours))
        d = plausibility_scores(pairs)
        cells = [f"{d[k][0]:5.3f}/{d[k][1]:5.3f}" for k in ("share", "sec", "last", "highest", "longest", "runs")]
        cells.append(f"{d['tenths'][0]:5.2f}/{d['tenths'][1]:5.2f}")
        print(f"{run:16s} " + " ".join(f"{c:>11s}" for c in cells) + f" {d['c2st']:5.3f}   ({len(pairs)} songs)")
