import pytest

from tunestudio_training.pipeline import ultrastar

from conftest import SIMPLE, write_chart


def test_parse_headers_notes_and_breaks(tmp_path):
    path = write_chart(tmp_path / "S", SIMPLE, bpm="300,5", gap="1500,5")
    song = ultrastar.parse(path)
    assert song.bpm == 300.5 and song.gap == 1500.5
    assert song.headers["LANGUAGE"] == "English"
    assert [len(p) for p in song.voices[0]] == [3, 4]
    assert song.breaks == {(0, 1): 22}
    first = song.notes()[0]
    assert (first.type, first.start, first.length, first.pitch, first.text, first.midi) == (
        "normal",
        0,
        4,
        0,
        "Hel",
        60,
    )
    assert song.beat_to_sec(4) == pytest.approx(1.5005 + 4 * 60 / (300.5 * 4))


def test_note_types_and_end(tmp_path):
    path = tmp_path / "s.txt"
    path.write_text("#BPM:100\n: 0 1 0 a\n* 1 1 0 b\nF 2 1 0 c\nR 3 1 0 d\nG 4 1 0 e\n: 5\nE\n: 9 1 0 after\n")
    song = ultrastar.parse(path)
    assert [n.type for n in song.notes()] == ["normal", "golden", "freestyle", "rap", "rap_golden"]


def test_duets(tmp_path):
    song = ultrastar.parse(write_chart(tmp_path / "D", SIMPLE, duet=True))
    assert len(song.voices) == 2 and song.notes(1)[0].text == "Hel"


@pytest.mark.parametrize("encoding, bom", [("utf-8", True), ("cp1252", False)])
def test_decoding(tmp_path, encoding, bom):
    text = "#TITLE:Männer\n#BPM:100\n: 0 1 0 Über\nE\n"
    raw = text.encode(encoding)
    (tmp_path / "s.txt").write_bytes((b"\xef\xbb\xbf" if bom else b"") + raw)
    song = ultrastar.parse(tmp_path / "s.txt")
    assert song.headers["TITLE"] == "Männer" and song.notes()[0].text == "Über"


def test_write_parse_round_trip(tmp_path):
    for duet in (False, True):
        song = ultrastar.parse(write_chart(tmp_path / "S", SIMPLE, duet=duet))
        ultrastar.write(song, tmp_path / "out.txt")
        again = ultrastar.parse(tmp_path / "out.txt")
        assert again.headers == song.headers
        assert again.voices == song.voices
        assert again.breaks == song.breaks
