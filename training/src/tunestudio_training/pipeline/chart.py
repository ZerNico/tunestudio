"""Turn aligned syllables + GAME's notes + a beat grid into UltraStar notes, then the song-wide clean-up: octaves,
golden notes, line splitting and line breaks."""

from dataclasses import dataclass

import numpy as np

from .align import WordTiming
from .pitch import HOP_SEC, PitchTrack
from .ultrastar import Note, Song


@dataclass
class Grid:
    bpm: float  # UltraStar #BPM
    gap: float  # seconds, time of UltraStar beat 0

    @property
    def unit(self) -> float:
        return 60 / (self.bpm * 4)

    def to_beat(self, t: float) -> int:
        return int(round((t - self.gap) / self.unit))

    def to_sec(self, beat: float) -> float:
        return self.gap + beat * self.unit


def make_grid(bpm: float, t0: float, first_note: float, units_per_beat: int = 16) -> Grid:
    """UltraStar grid from the fitted tempo, with beat 0 on the real beat just before the first note.

    16 UltraStar beats per real beat (#BPM = 4x the real tempo) is what most USDB charts use.
    """
    beat = 60 / bpm
    gap = t0 + np.floor((first_note - t0) / beat) * beat
    return Grid(bpm * units_per_beat / 4, gap)


@dataclass
class SyllableSpan:
    text: str  # with trailing space when it ends a word
    start: float
    end: float  # hard limit: the next syllable's start
    score: float


def syllable_spans(
    words: list[WordTiming], syllables: list[list[str]], next_line_start: float | None, max_tail: float = 1.5
) -> list[SyllableSpan]:
    """Split aligned words into syllables using the per-character timing.

    A syllable may last until the next one starts, but not more than `max_tail` past its word's aligned end:
    when the next word is misaligned far away (e.g. into the outro) the syllable would otherwise swallow it all.
    """
    spans: list[SyllableSpan] = []
    word_ends: list[float] = []
    for word, syls in zip(words, syllables):
        total = sum(len(s) for s in syls)
        pos = 0
        for si, syl in enumerate(syls):
            start = word.time_at(pos / total) if si else word.start
            pos += len(syl)
            text = syl + (" " if si == len(syls) - 1 else "")
            spans.append(SyllableSpan(text, start, 0.0, word.score))
            word_ends.append(word.end)
    nexts = [b.start for b in spans[1:]] + [next_line_start if next_line_start is not None else np.inf]
    for span, nxt, word_end in zip(spans, nexts, word_ends):
        span.end = min(nxt, max(word_end, span.start) + max_tail)
    return spans


def _snap(midi: float, scale: frozenset[int] | None, snap: float) -> int:
    """Round to a semitone, preferring the song's scale when the sung pitch lies between two semitones.

    `snap` widens the in-scale neighbour's catchment: 0 = plain rounding, 0.25 = in-scale wins up to 0.75 away.
    """
    nearest = int(round(midi))
    if not scale or snap <= 0 or nearest % 12 in scale:
        return nearest
    other = nearest + (1 if midi > nearest else -1)
    if other % 12 in scale and abs(midi - other) < 0.5 + snap:
        return other
    return nearest


def estimate_scale(track: PitchTrack, tuning: float) -> frozenset[int]:
    """The diatonic scale (as pitch classes) that covers most sung time; major and its relative minor are the same
    set."""
    m = track.midi[~np.isnan(track.midi)] - tuning
    hist = np.bincount(np.round(m).astype(int) % 12, minlength=12)
    major = np.array([0, 2, 4, 5, 7, 9, 11])
    best = max(range(12), key=lambda root: hist[(major + root) % 12].sum())
    return frozenset(int(x) for x in (major + best) % 12)


def tuning_offset(track: PitchTrack) -> float:
    """Global deviation from A440 in semitones (circular mean of the fractional pitch)."""
    m = track.midi[~np.isnan(track.midi)]
    return float(np.angle(np.mean(np.exp(2j * np.pi * m))) / (2 * np.pi))


def build_song(lines: list[list[Note]], grid: Grid, headers: dict[str, str]) -> Song:
    song = Song(headers=dict(headers))
    song.headers["BPM"] = f"{grid.bpm:.3f}".rstrip("0").rstrip(".")
    song.headers["GAP"] = str(int(round(grid.gap * 1000)))
    lines = [sorted(line, key=lambda n: n.start) for line in lines if line]
    # A "~" continuation on the same pitch, right after its note, is one held note (charters write that for 0.12%
    # of notes, we had 4.6%: notefix moves pitches after the merge in notes_for_line_game). Dev: note_f1 +0.009.
    # So is a short "~" (<= 0.12s) up to 3 semitones away: charters keep singing the previous note there, and it's
    # hard to hit (out/analysis/merge: 12-14% fewer short notes, note_f1 +0.002 dev / +0.007 sel, frame/pitch flat).
    tail = 0.12 / grid.unit
    for line in lines:
        kept: list[Note] = []
        for n in line:
            p = kept[-1] if kept else None
            if (
                p
                and n.text.strip() == "~"
                and n.type == p.type
                and n.start - (p.start + p.length) <= 1
                and (n.pitch == p.pitch or (abs(n.pitch - p.pitch) <= 3 and n.length <= tail))
            ):
                if n.length > p.length:
                    p.pitch = n.pitch
                p.length = n.start + n.length - p.start
                if n.text.endswith(" ") and not p.text.endswith(" "):
                    p.text += " "
                continue
            kept.append(n)
        line[:] = kept
    # Lines are charted independently (a held last note may run into the next line's first one), and fallback
    # or end-adjusted notes can collide: make starts strictly increasing and notes non-overlapping.
    notes = [n for line in lines for n in line]
    for a, b in zip(notes, notes[1:]):
        if b.start <= a.start:
            end = b.start + b.length
            b.start = a.start + 1
            b.length = max(1, end - b.start)
    for a, b in zip(notes, notes[1:]):
        if a.start + a.length > b.start:
            a.length = max(1, b.start - a.start - 1)
    # Notes under 0.1s are hard to hit: lengthen them into free time, keeping one unit before the next note
    # (dev: short notes 15.9 -> 8.7 per 100, hand-made 12.2; accuracy unchanged).
    least = int(np.ceil(0.1 / grid.unit))
    for a, b in zip(notes, notes[1:] + [None]):
        if a.length < least:
            a.length = max(a.length, min(least, b.start - a.start - 1) if b else least)
    song.voices = [lines]
    song.breaks = line_breaks(lines, grid)
    return song


def fix_octaves(
    lines: list[list[Note]],
    grid: Grid,
    track: PitchTrack,
    tuning: float = 0.0,
    wav: np.ndarray | None = None,
    sr: int = 44100,
    evidence: float = 0.0,
    leap: float = 0.6,
    stay: float = 2.0,
    center: float = 0.3,
    harmonic: float = 1.0,
) -> None:
    """Move notes by whole octaves so the melody doesn't jump around: the game scores any octave, but a note an
    octave off is drawn far away from its neighbours and a chart spanning 2-3 octaves is miserable to read.

    Viterbi over a shift of -12/0/+12 per note, song-wide: `evidence` per octave away from the singer's median
    pitch in the note (weighted by how much of it is voiced), `leap` per semitone beyond 7 to the previous note
    (less across pauses), `stay` for moving a note at all, `center` per semitone beyond 9 from the song's median
    note (hand-made charts have 0.3% of notes that far out, ours 4%). Pitch classes never change.

    Real octave jumps exist (a high "ooh", a chorus lift), so moving a note costs a lot (`stay`): checked against
    the hand-made dev charts, a move agrees with the charter's octave 115 times and undoes a jump the charter
    kept 64 times (with stay 1: 202 vs 250).

    The pitch track's octave is no help (`evidence` 0): where it disagrees with GAME, the charts side with GAME
    82% of the time; FCPE mostly tracks half the real pitch on low or rough voices. What does tell a too-low note:
    the vocals' harmonics (`harmonic`, see _harmonics). With them, dev: 192 moves fixed vs 42 jumps undone (115/64
    without), held-out sel songs 70/27 (54/27)."""
    notes = [n for line in lines for n in line if n.type in ("normal", "golden")]
    if len(notes) < 2:
        return
    shifts = (-12, 0, 12)
    sung, voiced = [], []
    for n in notes:
        frames = track.slice(grid.to_sec(n.start), grid.to_sec(n.start + n.length))
        v = frames[~np.isnan(frames)] - tuning
        sung.append(float(np.median(v)) if len(v) >= 3 else np.nan)
        voiced.append(len(v) / max(len(frames), 1))

    mid = float(np.median([n.midi for n in notes]))
    ratios = (
        [_harmonics(wav, sr, grid.to_sec(n.start), grid.to_sec(n.start + n.length), n.midi) for n in notes]
        if wav is not None and harmonic
        else None
    )

    def own(i: int, s: int) -> float:
        cost = stay * (s != 0) + center * max(0.0, abs(notes[i].midi + s - mid) - 9)
        if ratios is not None and ratios[i] is not None:
            # down: odd harmonics of the octave below (high = the sung pitch is that octave), up: of this pitch
            # (low = it's really an octave higher). Thresholds from dev and sel medians.
            down, up = ratios[i]
            hint = {-12: max(0.0, -1.0 - down), 12: max(0.0, up + 0.5), 0: max(0.0, down + 1.0) + max(0.0, -0.5 - up)}[
                s
            ]
            cost += harmonic * min(2.0, hint)
        if not np.isnan(sung[i]):
            cost += evidence * voiced[i] * abs(round((notes[i].midi + s - sung[i]) / 12))
        return cost

    def move(i: int, s0: int, s1: int) -> float:
        jump = abs(notes[i].midi + s1 - notes[i - 1].midi - s0)
        pause = grid.to_sec(notes[i].start) - grid.to_sec(notes[i - 1].start + notes[i - 1].length)
        return leap * max(0, jump - 7) / (1 + max(pause, 0) / 0.5)

    cost = np.array([own(0, s) for s in shifts])
    back = []
    for i in range(1, len(notes)):
        step = np.array([[cost[a] + move(i, s0, s1) for a, s0 in enumerate(shifts)] for s1 in shifts])
        back.append(step.argmin(axis=1))
        cost = step.min(axis=1) + np.array([own(i, s) for s in shifts])
    k = int(cost.argmin())
    for i in range(len(notes) - 1, -1, -1):
        notes[i].pitch += shifts[k]
        if i:
            k = int(back[i - 1][k])


def mark_golden(
    lines: list[list[Note]],
    grid: Grid,
    track: PitchTrack,
    tuning: float = 0.0,
    share: float = 0.05,
    min_sec: float = 0.4,
) -> None:
    """Golden notes (double points): 90% of the train charts have them, a median 4% of their notes. Charters pick
    long held notes, so: the `share` of notes with the most steadily sung time on the charted pitch (at least
    `min_sec`), spread out so no tenth of the song gets more than a quarter of them."""
    notes = [n for line in lines for n in line if n.type == "normal"]
    want = int(round(share * len(notes)))
    if want == 0:
        return
    scored = []
    for n in notes:
        a, b = grid.to_sec(n.start), grid.to_sec(n.start + n.length)
        if b - a < min_sec:
            continue
        frames = track.slice(a, b) - tuning
        d = np.abs(frames[~np.isnan(frames)] - n.midi) % 12
        on_pitch = np.sum(np.minimum(d, 12 - d) <= 0.5) * HOP_SEC
        scored.append((on_pitch, n))
    first, last = notes[0].start, notes[-1].start + notes[-1].length
    per_tenth: dict[int, int] = {}
    cap = max(1, want // 4)
    for on_pitch, n in sorted(scored, key=lambda x: -x[0]):
        if want == 0 or on_pitch < min_sec * 0.6:
            break
        tenth = min(9, int(10 * (n.start - first) / max(last - first, 1)))
        if per_tenth.get(tenth, 0) >= cap:
            continue
        per_tenth[tenth] = per_tenth.get(tenth, 0) + 1
        n.type = "golden"
        want -= 1


def _harmonics(wav: np.ndarray, sr: int, a: float, b: float, midi: int) -> tuple[float, float] | None:
    """log10(odd / even harmonic energy) of the vocals over a note, for the octave below and for the note's pitch.
    If the voice really sits an octave lower, the odd harmonics of that lower pitch are strong (they don't exist
    an octave up); if the note is an octave too low, its odd harmonics are weak."""
    n, hop = 4096, 1024
    i, j = int(a * sr), int(b * sr)
    frames = [wav[t : t + n] for t in range(i, max(i + 1, j - n), hop) if t + n <= len(wav)]
    if not frames:
        return None
    power = np.mean(np.abs(np.fft.rfft(np.array(frames) * np.hanning(n), axis=1)) ** 2, axis=0)
    freqs = np.fft.rfftfreq(n, 1 / sr)

    def energy(f0: float, ks: range) -> float:
        e = 0.0
        for k in ks:
            if k * f0 > 5000:
                break
            c = int(np.searchsorted(freqs, k * f0))
            e += float(power[max(c - 2, 0) : c + 3].max())
        return e + 1e-12

    low, own_ = 440 * 2 ** ((midi - 12 - 69) / 12), 440 * 2 ** ((midi - 69) / 12)
    down = np.log10(energy(low, range(1, 16, 2)) / energy(low, range(2, 17, 2)))
    up = np.log10(energy(own_, range(1, 12, 2)) / energy(own_, range(2, 13, 2)))
    return float(down), float(up)


def _text(notes: list[Note]) -> str:
    return "".join(n.text for n in notes if n.text.strip() != "~").strip()


def split_lines(
    lines: list[list[Note]], grid: Grid, max_chars: int = 40, max_sec: float = 6.0, pause: float = 0.6
) -> list[list[Note]]:
    """Break lyric lines (LRCLIB's, often two sung phrases long) the way charters do, measured on the train
    charts: at nearly every pause of `pause` s or more between words (93% of them are line breaks there), and lines
    over `max_chars` characters or `max_sec` seconds (beyond the hand-made 95th-99th percentile) at their best
    word gap: long pause, punctuation, balanced halves. Never inside a word, never leaving a one-word line."""

    def cuts(line: list[Note]) -> list[tuple[int, float]]:
        out = []
        for i in range(1, len(line)):
            a, b = line[i - 1], line[i]
            if not a.text.endswith(" ") or b.text.strip() in ("~", ""):
                continue
            if len(_text(line[:i]).split()) < 2 or len(_text(line[i:]).split()) < 2:
                continue
            out.append((i, (b.start - a.start - a.length) * grid.unit))
        return out

    def split(line: list[Note]) -> list[list[Note]]:
        options = cuts(line)
        if not options:
            return [line]
        i, gap = max(options, key=lambda c: c[1])
        too_long = (
            len(_text(line)) > max_chars or (line[-1].start + line[-1].length - line[0].start) * grid.unit > max_sec
        )
        if gap < pause and not too_long:
            return [line]
        if gap < pause:  # too long without a clear pause: weigh punctuation and balance too
            total = len(_text(line))

            def score(c: tuple[int, float]) -> float:
                left = _text(line[: c[0]])
                return c[1] + (0.3 if left[-1:] in ",.;:!?" else 0.0) - 0.5 * abs(2 * len(left) - total) / total

            i = max(options, key=score)[0]
        return split(line[:i]) + split(line[i:])

    return [part for line in lines if line for part in split(line)]


def line_breaks(
    lines: list[list[Note]], grid: Grid, share: float = 0.4, most: float = 2.0
) -> dict[tuple[int, int], int]:
    """Line-break beats: USDX switches to the next line when the break beat is reached, so a break on the next
    line's first note leaves no time to read ahead. Hand-made charts break soon after the previous line ends,
    about 1 s in for 2-4 s pauses (measured on the train charts): here `share` of the pause, at most `most`
    seconds, and always before the next line starts."""
    out = {}
    for j in range(1, len(lines)):
        end = max(n.start + n.length for n in lines[j - 1])
        nxt = lines[j][0].start
        pause = (nxt - end) * grid.unit
        beat = end + int(round(min(share * pause, most) / grid.unit))
        out[(0, j)] = min(max(beat, end), nxt)
    return out


def notes_for_line_game(
    spans: list[SyllableSpan],
    wav: np.ndarray,
    model,
    grid: Grid,
    language: int = 0,
    scale: frozenset[int] | None = None,
    scale_snap: float = 0.35,
    gap_units: int = 1,
    pad: float = 0.2,
    max_syllable: float = 3.0,
    presence_threshold: float = 0.2,
    boundary_threshold: float = 0.2,
    trace: list[dict] | None = None,
) -> list[Note]:
    """Notes for one line from GAME, with the aligned syllable starts as known boundaries.

    GAME keeps those boundaries and only adds splits inside syllables (melismas), decides which parts are sung
    (presence) and estimates each note's pitch. A syllable may not extend more than `max_syllable` seconds
    (misaligned spans). `trace`: if given, one dict per returned note is appended (GAME's raw pitch etc.), for the
    learned post-steps.
    """
    if not spans:
        return []
    ends = [min(s.end, s.start + max_syllable) for s in spans]
    a = max(0.0, spans[0].start - pad)
    b = min(len(wav) / model.sr, ends[-1] + pad)
    cuts = [a] + [s.start for s in spans if a < s.start < b] + [b]
    cuts = sorted(set(cuts))
    known = [float(y - x) for x, y in zip(cuts, cuts[1:]) if y > x]
    chunk = wav[int(a * model.sr) : int(b * model.sr)]
    if len(chunk) < model.sr * 0.1:
        return []
    raw = model.extract(
        chunk, known, language, boundary_threshold=boundary_threshold, presence_threshold=presence_threshold
    )

    notes: list[Note] = []
    guessed: list[int] = []  # unvoiced syllables at the start of the line: no pitch to copy from yet
    for si, span in enumerate(spans):
        lo, hi = span.start, ends[si]
        mine = [n for n in raw if n.voiced and lo - 0.02 <= a + (n.start + n.end) / 2 < hi]
        # Merge neighbours GAME split but that land on the same semitone.
        merged: list[list[float]] = []
        for n in mine:
            if merged and abs(round(n.midi) - round(merged[-1][2])) == 0 and a + n.start - merged[-1][1] < 0.05:
                merged[-1][1] = a + n.end
            else:
                merged.append([a + n.start, a + n.end, n.midi])
        if not merged:
            if len(guessed) == len(notes):
                guessed.append(len(notes))
            pitch = notes[-1].pitch if notes else 0
            start = grid.to_beat(span.start)
            length = max(1, grid.to_beat(min(hi, span.start + 0.3)) - start)
            notes.append(Note("normal", start, length, pitch, span.text))
            if trace is not None:
                trace.append(
                    {
                        "start": span.start,
                        "end": min(hi, span.start + 0.3),
                        "raw": float(pitch + 60),
                        "syl": si,
                        "part": 0,
                        "parts": 0,
                    }
                )
            continue
        for k, (s, e, midi) in enumerate(merged):
            if k > 0:
                prev = merged[k - 1][2]
                while midi - prev > 7:
                    midi -= 12
                while prev - midi > 7:
                    midi += 12
                merged[k][2] = midi
            start = grid.to_beat(s)
            if notes and start < notes[-1].start + notes[-1].length:
                start = notes[-1].start + notes[-1].length
            length = max(1, grid.to_beat(e) - start)
            text = span.text if k == 0 else "~"
            if k == 0 and len(merged) > 1 and span.text.endswith(" "):
                text = span.text.rstrip()
            if k == len(merged) - 1 and k > 0 and span.text.endswith(" "):
                text = "~ "
            notes.append(Note("normal", start, length, _snap(midi, scale, scale_snap) - 60, text))
            if trace is not None:
                trace.append({"start": s, "end": e, "raw": float(midi), "syl": si, "part": k, "parts": len(merged)})
    # Those got C4 as a placeholder (often far off the melody): take the line's first sung pitch instead.
    if guessed and len(guessed) < len(notes):
        pitch = notes[len(guessed)].pitch
        for i in guessed:
            notes[i].pitch = pitch
            if trace is not None:
                trace[i]["raw"] = float(pitch + 60)
    for x, y in zip(notes, notes[1:]):
        if x.start + x.length > y.start - gap_units and x.length > gap_units + 1 and y.text.strip() not in ("~", ""):
            x.length = y.start - x.start - gap_units
    return notes
