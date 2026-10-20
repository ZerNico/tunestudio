"""Compare a generated chart with a hand-made one on a 10ms frame grid, octave-agnostic like the game's scoring."""

from dataclasses import asdict, dataclass

import numpy as np

from tunestudio_training.pipeline.pitch import PitchTrack
from tunestudio_training.pipeline.ultrastar import Song

HOP = 0.01
SCOOP_BIAS = 0.07
SUNG = ("normal", "golden")


def _frames(song: Song, n: int, types: tuple[str, ...] = SUNG) -> np.ndarray:
    """MIDI pitch per frame, NaN where no note of `types`."""
    out = np.full(n, np.nan)
    for note in song.notes():
        if note.type not in types:
            continue
        a = int(song.beat_to_sec(note.start) / HOP)
        b = int(song.beat_to_sec(note.start + note.length) / HOP)
        out[max(a, 0) : max(b, 0)] = note.midi
    return out


@dataclass
class Scores:
    recall: float  # share of reference note time covered by a generated note
    precision: float  # share of generated note time inside a reference note (time under rap/freestyle ignored)
    pitch_exact: float  # where both have a note: same pitch class
    pitch_within1: float  # ... within one semitone
    combined: float  # share of reference note time covered with the exact pitch class
    tempo_ratio: float  # generated / reference BPM, folded into [0.75, 1.5) so double/half time reads as 1
    # Note-level (mir_eval style, one-to-one matching): extra notes cost precision here, unlike `combined`.
    note_f1: float  # onset within ONSET_TOL and same pitch class
    onset_f1: float  # onset within ONSET_TOL, any pitch
    syllable_f1: float  # syllable starts only (notes whose text isn't "~"), onset within ONSET_TOL: lyric timing
    note_count_ratio: float  # generated / reference sung notes
    note_f1_off: float  # note_f1 + offset within max(OFFSET_TOL, 20% of the reference note): note ends / gaps
    frame_f1: float  # F1 of note time with the right pitch class: `combined` as recall, the same over our note time
    # as precision, so notes that are too long cost as much as notes that are too short

    def row(self) -> dict:
        return {k: round(v, 3) for k, v in asdict(self).items()}


ONSET_TOL = 0.1
OFFSET_TOL = 0.1


def _note_list(song: Song) -> list[tuple[float, float, int, bool]]:
    """(onset s, offset s, midi, is continuation "~") of the sung notes."""
    return [
        (song.beat_to_sec(n.start), song.beat_to_sec(n.start + n.length), n.midi, n.text.strip() in ("~", ""))
        for n in song.notes()
        if n.type in SUNG
    ]


def _f1(ref: list, gen: list, pitch: bool, tol: float = ONSET_TOL, offsets: bool = False) -> float:
    """F1 of a one-to-one onset matching (closest pairs first), octave-agnostic pitch class if `pitch`, offsets
    within max(OFFSET_TOL, 20% of the reference note's length) if `offsets` (mir_eval's onset-offset F1)."""
    if not ref or not gen:
        return 0.0
    ref = sorted(ref)
    r_on = np.array([n[0] for n in ref])
    pairs = []
    for j, g in enumerate(gen):
        lo, hi = np.searchsorted(r_on, g[0] - tol), np.searchsorted(r_on, g[0] + tol, side="right")
        for i in range(lo, hi):
            if pitch and (round(g[2] - ref[i][2]) % 12) != 0:
                continue
            if offsets and abs(g[1] - ref[i][1]) > max(OFFSET_TOL, 0.2 * (ref[i][1] - ref[i][0])):
                continue
            pairs.append((abs(g[0] - r_on[i]), i, j))
    used_r, used_g, hits = set(), set(), 0
    for _, i, j in sorted(pairs):
        if i not in used_r and j not in used_g:
            used_r.add(i)
            used_g.add(j)
            hits += 1
    p, r = hits / len(gen), hits / len(ref)
    return 2 * p * r / (p + r) if hits else 0.0


def _frame_f1(hits: int, ref_frames: int, gen_frames: int) -> float:
    p, r = hits / max(gen_frames, 1), hits / max(ref_frames, 1)
    return 2 * p * r / (p + r) if hits else 0.0


def compare(ref: Song, gen: Song) -> Scores:
    end = max(ref.beat_to_sec(n.start + n.length) for n in ref.notes()) + 5
    n = int(end / HOP)
    r, g = _frames(ref, n), _frames(gen, n)
    rv, gv = ~np.isnan(r), ~np.isnan(g)
    unpitched = ~np.isnan(_frames(ref, n, ("freestyle", "rap", "rap_golden")))
    both = rv & gv
    pc = (np.round(g[both] - r[both]) + 6) % 12 - 6
    ratio = gen.bpm / ref.bpm
    while ratio < 0.75:
        ratio *= 2
    while ratio >= 1.5:
        ratio /= 2
    rn, gn = _note_list(ref), _note_list(gen)
    rs = [n for n in rn if not n[3]]
    gs = [n for n in gn if not n[3]]
    return Scores(
        note_f1=_f1(rn, gn, pitch=True),
        onset_f1=_f1(rn, gn, pitch=False),
        syllable_f1=_f1(rs, gs, pitch=False),
        note_count_ratio=len(gn) / max(len(rn), 1),
        note_f1_off=_f1(rn, gn, pitch=True, offsets=True),
        frame_f1=_frame_f1(np.sum(pc == 0), rv.sum(), (gv & ~unpitched).sum()),
        recall=both.sum() / max(rv.sum(), 1),
        precision=both.sum() / max((gv & ~unpitched).sum(), 1),
        pitch_exact=float(np.mean(pc == 0)) if len(pc) else 0.0,
        pitch_within1=float(np.mean(np.abs(pc) <= 1)) if len(pc) else 0.0,
        combined=float(np.sum(pc == 0) / max(rv.sum(), 1)),
        tempo_ratio=ratio,
    )


def reference_offset(ref: Song, track: PitchTrack, search: float = 0.6) -> float:
    """Seconds to add to the reference chart so it lines up with this audio file.

    USDB charts are timed against whatever audio the charter had; a different encode or video rip is often
    shifted by 100-200ms. Found by sliding the chart's pitch frames over the singer's pitch track (octave-agnostic).

    Pitch agreement peaks ~70ms late because singers scoop into notes (the pitch arrives after the onset the
    charter marked); on 15 songs, subtracting that matched the median word-onset offset within ~20ms on 13.
    """
    n = int(track.times[-1] / HOP) + 1
    r = _frames(ref, n + int(2 * search / HOP))
    sung = np.interp(np.arange(n) * HOP, track.times, track.midi)
    best, best_shift = -1.0, 0
    for shift in range(-int(search / HOP), int(search / HOP) + 1):
        rs = np.roll(r, shift)[:n]
        both = ~np.isnan(rs) & ~np.isnan(sung)
        if both.sum() < 100:
            continue
        diff = np.abs(sung[both] - rs[both]) % 12
        hit = np.mean(np.minimum(diff, 12 - diff) <= 1)
        if hit > best:
            best, best_shift = hit, shift
    return best_shift * HOP - SCOOP_BIAS


def shifted(song: Song, seconds: float) -> Song:
    out = Song(headers=dict(song.headers), voices=song.voices, breaks=dict(song.breaks))
    out.headers["GAP"] = str(song.gap + seconds * 1000)
    return out
