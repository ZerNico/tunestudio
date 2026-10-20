"""Minimal UltraStar TXT reader/writer (format 1.0-1.2), enough to evaluate against and to export charts."""

from dataclasses import dataclass, field
from pathlib import Path

NOTE_TYPES = {":": "normal", "*": "golden", "F": "freestyle", "R": "rap", "G": "rap_golden"}
TYPE_CHARS = {v: k for k, v in NOTE_TYPES.items()}


@dataclass
class Note:
    type: str  # normal | golden | freestyle | rap | rap_golden
    start: int  # beats
    length: int  # beats
    pitch: int  # semitones, 0 = C4 (MIDI 60)
    text: str

    @property
    def midi(self) -> int:
        return self.pitch + 60


@dataclass
class Song:
    headers: dict[str, str] = field(default_factory=dict)
    # One list of phrases per voice; a phrase is a list of notes.
    voices: list[list[list[Note]]] = field(default_factory=lambda: [[[]]])
    # Line-break beat before phrase j of voice v ("- <beat>"): when USDX switches to that line. Missing = the
    # phrase's first note.
    breaks: dict[tuple[int, int], int] = field(default_factory=dict)

    @property
    def bpm(self) -> float:
        return float(self.headers["BPM"].replace(",", "."))

    @property
    def gap(self) -> float:
        """Milliseconds."""
        return float(self.headers.get("GAP", "0").replace(",", "."))

    def beat_to_sec(self, beat: float) -> float:
        # UltraStar beats are quarter notes of the stated BPM.
        return self.gap / 1000 + beat * 60 / (self.bpm * 4)

    def notes(self, voice: int = 0) -> list[Note]:
        return [n for phrase in self.voices[voice] for n in phrase]


def _decode(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode("latin-1")


def parse(path: str | Path) -> Song:
    song = Song()
    voice = 0
    for line in _decode(Path(path).read_bytes()).splitlines():
        if not line.strip():
            continue
        tag = line[0]
        if tag == "#":
            key, _, value = line[1:].partition(":")
            song.headers[key.strip().upper()] = value.strip()
        elif tag in NOTE_TYPES:
            parts = line[1:].lstrip().split(" ", 3)
            if len(parts) < 3:
                continue
            text = parts[3] if len(parts) > 3 else ""
            note = Note(NOTE_TYPES[tag], int(parts[0]), int(parts[1]), int(parts[2]), text)
            song.voices[voice][-1].append(note)
        elif tag == "-":
            if song.voices[voice][-1]:
                song.voices[voice].append([])
                beat = line[1:].split()
                if beat and beat[0].lstrip("-").isdigit():
                    song.breaks[(voice, len(song.voices[voice]) - 1)] = int(beat[0])
        elif tag == "P":
            voice = int(line[1:].strip()) - 1
            while len(song.voices) <= voice:
                song.voices.append([[]])
        elif tag == "E":
            break
    for phrases in song.voices:
        if phrases and not phrases[-1]:
            phrases.pop()
    return song


def write(song: Song, path: str | Path) -> None:
    out = [f"#{k}:{v}" for k, v in song.headers.items()]
    duet = len(song.voices) > 1
    for i, phrases in enumerate(song.voices):
        if duet:
            out.append(f"P{i + 1}")
        for j, phrase in enumerate(phrases):
            if j > 0:
                out.append(f"- {song.breaks.get((i, j), phrase[0].start)}")
            out += [f"{TYPE_CHARS[n.type]} {n.start} {n.length} {n.pitch} {n.text}" for n in phrase]
    out.append("E")
    Path(path).write_text("\n".join(out) + "\n", encoding="utf-8")
