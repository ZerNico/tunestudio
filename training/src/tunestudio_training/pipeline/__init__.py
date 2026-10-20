"""The default chart pipeline, as Tune Studio runs it: audio + lyrics in, an UltraStar chart out. Vocal stem, pitch
track, beat grid, whole-song alignment of the lyrics, syllable starts moved to the boundary head's peaks, GAME's
notes per line, the pitch corrector, learned note ends, then octaves, golden notes and line breaks. Every stage
caches its result in the work dir.

Tune Studio's TypeScript/Rust pipeline is a port of this one, checked against goldens recorded from it (`tst goldens`).
"""

import hashlib
import json
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from tunestudio_training import paths, recipes

from . import align, beats, boundary, chart, ends, game, lyrics, notefix, onnx_models, pitch, separate, ultrastar

# Syllable starts move to the boundary head's peaks by one-to-one assignment (boundary.assign) within ±0.3 s.
# cost 0.5 (vs 1.0; dev+sel note_f1 +0.004/+0.005, syllable_f1 +0.007, fewer short notes; 2.0 is clearly worse,
# 0.25 = 0.5, min_prob 0.15-0.5 makes no difference). radius 0.3 (vs 0.2: syllable_f1 +0.002/+0.003, fewer short
# notes, none worse; 0.12 is clearly worse, 0.4 = 0.3).
BOUNDARY = {"radius": 0.3, "min_prob": 0.3, "cost": 0.5}
NOTEFIX_THRESHOLD = 0.5  # a note moves when the corrector is at least this sure of a shift
GAP_UNITS = 1  # beats kept free before a note that starts a syllable
# Options for `run`: the learned steps' checkpoints (None switches a step off), another GAME model, and "dump_notes",
# which writes every note's notefix features (before any correction) to notes.json for `tst dataset notes`.
OPTIONS = ("notefix", "boundary_model", "ends_model", "game_model", "dump_notes")


def default_learned() -> dict[str, str]:
    """The learned steps' checkpoints in TST_MODELS. nf1/e1 had 640 train songs, nf3/e2 1,178 (dev: frame_f1 +0.003,
    none worse), nf4/e3 2,627 (dev+sel: primaries flat, combined +0.005/+0.007, recall +0.006/+0.010)."""
    models, shipped = paths.models(), recipes.SHIPPED
    return {
        "notefix": str(models / "notefix" / f"{shipped['notefix']}.pkl"),
        "boundary_model": str(models / "boundary" / f"{shipped['boundary']}.pt"),
        # notes end where charters end them (with gaps), not when the voice stops
        "ends_model": str(models / "ends" / f"{shipped['ends']}.pkl"),
    }


def load_track(work: Path) -> pitch.PitchTrack:
    d = np.load(work / "pitch.npz")
    return pitch.PitchTrack(d["times"], d["midi"], d["rms"] if "rms" in d else None)


@dataclass
class LyricLine:
    text: str
    start: float | None = None  # rough, e.g. from LRCLIB
    end: float | None = None
    # The line's start in other timings of the same lyrics (other LRCLIB versions, see lrclib.versions); the
    # alignment stage uses whichever timing fits the recording best.
    alt_starts: tuple[float, ...] = ()


def _cached_align(
    vocals: Path, requests: list[align.Line], language: str, work: Path, pad: float
) -> list[list[align.WordTiming]]:
    # The aligner joins the key by name (the same key on every machine), and the ONNX aligner's emissions differ
    # slightly, so it has its own alignments.
    extra = ([pad] if pad else []) + [Path(align.model_path()).name]
    if onnx_models.folder():
        extra.append("onnx")
    key = hashlib.sha1(json.dumps([asdict(r) for r in requests] + [language] + extra).encode()).hexdigest()[:12]
    cache = work / f"align-{key}.json"
    if cache.exists():
        return [[align.WordTiming(**w) for w in line] for line in json.loads(cache.read_text())]
    aligned = align.align(str(vocals), requests, language, pad=pad)
    cache.write_text(json.dumps([[asdict(w) for w in line] for line in aligned]))
    return aligned


def _split(flat: list, sizes: list[int]) -> list[list]:
    out = []
    for size in sizes:
        out.append(flat[:size])
        flat = flat[size:]
    return out


def _align_stage(
    vocals: Path,
    lines: list[LyricLine],
    language: str,
    work: Path,
    track: pitch.PitchTrack,
    max_off: float = 1.0,
    min_score: float = -3.0,
    pad: float = 1.0,
) -> list[list[align.WordTiming]]:
    """Whole-song alignment; with line times (LRCLIB) they are used as a sanity check against drift.

    Line-synced lyrics are timed against some version of the song and are only roughly right, so they don't
    replace the alignment (pinning every line to its window cut words and scored worse). Their offset to this
    file is estimated from the lines the aligner is confident about, and only lines that start more than
    `max_off` away from where the lyrics say, or score very low, are re-aligned inside their window.
    """
    words = [line.text.split() for line in lines]
    sizes = [sum(align.is_word(w) for w in ws) for ws in words]
    timed = all(line.start is not None for line in lines)
    try:
        aligned = _split(
            _cached_align(vocals, [align.Line([w for ws in words for w in ws])], language, work, 0)[0], sizes
        )
    except (RuntimeError, ValueError):
        # The CTC aligner fails on some long whole-song inputs (std::vector length error); with line times,
        # align line by line in their windows instead.
        if not timed:
            raise
        return _windowed(vocals, lines, words, language, work, track, pad)
    if timed:
        # Offset and spread of each timing against the lines the aligner is confident about; keep the best fit.
        confident = [i for i, ws in enumerate(aligned) if ws and np.mean([w.score for w in ws]) > -2]
        n_alt = min((len(ln.alt_starts) for ln in lines), default=0)
        timings = [[ln.start for ln in lines]] + [[ln.alt_starts[k] for ln in lines] for k in range(n_alt)]
        fits = []
        for starts in timings:
            diffs = np.array([aligned[i][0].start - starts[i] for i in confident if np.isfinite(starts[i])])
            offset = float(np.median(diffs)) if len(diffs) else 0.0
            # too few matched lines can't vouch for a timing
            ok = len(diffs) >= max(5, 0.3 * len(confident))
            fits.append((float(np.median(np.abs(diffs - offset))) if ok else np.inf, offset, starts, len(diffs)))
        spread, offset, chosen, n_used = min(fits, key=lambda f: f[0])
        diffs = range(n_used)
        lines = [LyricLine(ln.text, st, ln.end) for ln, st in zip(lines, chosen)]
        # Large offsets are fine (music videos often have a long intro); an inconsistent timing is not.
        if spread > 1.0 or abs(offset) > 120:
            # The LRC version doesn't match this recording (e.g. another edit): its times would only mislead.
            reason = {"offset": offset, "spread": spread, "ignored": True}
            (work / "lrc_offset.json").write_text(json.dumps(reason))
            timed = False
    if timed:
        starts = [ln.start + offset for ln in lines]
        song_end = float(track.times[-1])
        fixed = []
        for i, ws in enumerate(aligned):
            if not ws or not np.isfinite(starts[i]):  # NaN: line not in the chosen timing's version
                continue
            if abs(ws[0].start - starts[i]) <= max_off and np.mean([w.score for w in ws]) >= min_score:
                continue
            end = next((st for st in starts[i + 1 :] if np.isfinite(st)), song_end)
            if end <= starts[i]:
                continue  # LRC times out of order
            request = align.Line(words[i], max(0.0, starts[i] - pad), end + pad)
            try:
                aligned[i] = _cached_align(vocals, [request], language, work, 0)[0]
                fixed.append(i)
            except (RuntimeError, ValueError):
                pass  # window too short for the text: keep the whole-song result
        timing = timings.index(chosen)
        (work / "lrc_offset.json").write_text(
            json.dumps(
                {
                    "offset": offset,
                    "spread": spread,
                    "lines_used": len(diffs),
                    "timing": timing,
                    "timings": len(timings),
                    "realigned": fixed,
                }
            )
        )
    for line in aligned:
        align.pull_in_edges(line)
        align.snap_to_voice(line, track.midi, track.rms, pitch.HOP_SEC)
    return aligned


def _windowed(vocals, lines, words, language, work, track, pad) -> list[list[align.WordTiming]]:
    song_end = float(track.times[-1])
    out = []
    for i, (line, ws) in enumerate(zip(lines, words)):
        end = lines[i + 1].start if i + 1 < len(lines) else song_end
        try:
            out.append(
                _cached_align(vocals, [align.Line(ws, max(0.0, line.start - pad), end + pad)], language, work, 0)[0]
            )
        except (RuntimeError, ValueError):
            out.append([])
    for line in out:
        align.pull_in_edges(line)
        align.snap_to_voice(line, track.midi, track.rms, pitch.HOP_SEC)
    return out


@dataclass
class Result:
    song: ultrastar.Song
    timings: dict[str, float] = field(default_factory=dict)
    word_scores: list[float] = field(default_factory=list)


class _Timed:
    def __init__(self, timings: dict[str, float], name: str):
        self.timings, self.name = timings, name

    def __enter__(self):
        self.start = time.time()

    def __exit__(self, *_):
        self.timings[self.name] = round(time.time() - self.start, 2)


def stems(audio: str, work: Path, keep_instrumental: bool = True) -> tuple[Path, pitch.PitchTrack]:
    """Vocal stem + pitch/loudness track, cached in the work dir."""
    work.mkdir(parents=True, exist_ok=True)
    vocals = separate.vocals(audio, work)
    if not keep_instrumental:
        (work / "instrumental.flac").unlink(missing_ok=True)
    cache = work / "pitch.npz"
    track = load_track(work) if cache.exists() else pitch.track(str(vocals))
    if not cache.exists() or track.rms is None:  # pitch caches from before the loudness was kept lack it
        if track.rms is None:
            track.rms = pitch.loudness(pitch.load(str(vocals), pitch.SR), len(track.times))
        np.savez(cache, times=track.times, midi=track.midi, rms=track.rms)
    return vocals, track


def run(
    audio: str,
    lines: list[LyricLine],
    language: str,
    work: Path,
    headers: dict[str, str] | None = None,
    options: dict | None = None,
) -> Result:
    """Chart a song. `options` (see OPTIONS) override the defaults; with TST_ONNX the learned steps run the export's
    models, so their options only switch them on and off."""
    options = options or {}
    unknown = set(options) - set(OPTIONS)
    if unknown:  # a typo must not be ignored silently
        raise ValueError(f"unknown chart options: {sorted(unknown)}")
    opts = {**default_learned(), **options}
    work.mkdir(parents=True, exist_ok=True)
    t: dict[str, float] = {}

    with _Timed(t, "stems"):
        vocals, track = stems(audio, work)

    with _Timed(t, "beats"):
        cache = work / "beats.npz"
        if cache.exists():
            d = np.load(cache)
            b = beats.Beats(d["beats"], d["downbeats"])
        else:
            b = beats.track(audio)
            np.savez(cache, beats=b.beats, downbeats=b.downbeats)
        bpm, t0, residual = b.fit_grid()

    with _Timed(t, "align"):
        # "(...)" backing-vocal parts of the lyrics are left out: forcing them into the alignment pushes the following
        # lines out of place. sel: note_f1 +0.012, syllable_f1 +0.019, fewer short notes; dev: note_f1 +0.006; recall
        # -0.004/-0.006 (charted backing parts are lost).
        stripped = [
            LyricLine(" ".join(re.sub(r"\([^)]*\)?", " ", ln.text).split()), ln.start, ln.end, ln.alt_starts)
            for ln in lines
        ]
        lines = [ln for ln in stripped if any(align.is_word(w) for w in ln.text.split())]
        aligned = _align_stage(vocals, lines, language, work, track)

    with _Timed(t, "chart"):
        first = next(w.start for line in aligned for w in line)
        grid = chart.make_grid(bpm, t0, first)
        tuning = chart.tuning_offset(track)
        scale = chart.estimate_scale(track, tuning)
        probs = boundary.probabilities(str(vocals), opts["boundary_model"]) if opts["boundary_model"] else None
        model = game.model(opts.get("game_model"))
        wav = pitch.load(str(vocals), model.sr)
        language_id = model.language_id(language)
        dump: list[dict] | None = [] if opts.get("dump_notes") else None
        out_lines = []
        for li, words in enumerate(aligned):
            if not words:
                continue
            nxt = next((ws[0].start for ws in aligned[li + 1 :] if ws), None)
            syls = [lyrics.syllabify(w.text, language) for w in words]
            spans = chart.syllable_spans(words, syls, nxt)
            if probs is not None:
                for span, start in zip(spans, boundary.assign([sp.start for sp in spans], probs, **BOUNDARY)):
                    span.start = start
                for a, b in zip(spans, spans[1:]):
                    a.end = min(a.end, b.start)
            trace: list[dict] = []
            notes = chart.notes_for_line_game(spans, wav, model, grid, trace=trace, scale=scale, language=language_id)
            if dump is not None:
                feats = notefix.features(notes, trace, track, tuning, scale)
                dump += [
                    {"start": tr["start"], "end": tr["end"], "midi": n.midi, "x": f}
                    for n, tr, f in zip(notes, trace, feats)
                ]
            if opts["notefix"]:
                notefix.apply(notes, trace, track, tuning, scale, opts["notefix"], NOTEFIX_THRESHOLD)
            if opts["ends_model"]:
                feats = notefix.features(notes, trace, track, tuning, scale)
                ends.apply(notes, trace, feats, grid, opts["ends_model"], GAP_UNITS)
            out_lines.append(notes)

    if dump is not None:
        (work / "notes.json").write_text(json.dumps(dump))
    # #MP3 next to #AUDIO for apps older than format 1.0 (USDX ignores it when #AUDIO is there).
    hdr = {
        "VERSION": "1.2.0",
        **(headers or {}),
        "LANGUAGE": language,
        "AUDIO": Path(audio).name,
        "MP3": Path(audio).name,
    }
    hdr.setdefault("CREATOR", "auto-tuner")
    hdr["VOCALS"] = vocals.name
    chart.fix_octaves(out_lines, grid, track, tuning, wav, model.sr)
    chart.mark_golden(out_lines, grid, track, tuning)
    song = chart.build_song(chart.split_lines(out_lines, grid), grid, hdr)
    (work / "meta.json").write_text(
        json.dumps({"bpm": bpm, "t0": t0, "beat_residual": residual, "tuning": tuning, "timings": t}, indent=2)
    )
    return Result(song, t, [w.score for line in aligned for w in line])
