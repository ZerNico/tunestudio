import io

import pytest

from tunestudio_training import progress


def test_part():
    assert progress.part(None) is None
    assert progress.part("1/3") == (1, 3)
    assert progress.select(list(range(7)), "1/3") == [1, 4]
    for bad in ("3/3", "-1/2", "a/b", "1", "0/0"):
        with pytest.raises(SystemExit, match="--part"):
            progress.part(bad)


def test_duration():
    assert [progress.duration(s) for s in (5, 59.6, 600, 3600 * 3 + 600)] == ["5s", "1m", "10m", "3h10m"]


def test_progress_lines_and_summary():
    out = io.StringIO()
    bar = progress.Progress(4, out)
    bar.done(0, "a", "ok", 60)
    bar.done(1, "b", "no stems yet")
    bar.done(2, "c", "FAILED boom", 120)
    bar.done(3, "d", "ok", 30)
    assert bar.summary() == "4 songs: 1 failed, 1 no stems yet, 2 ok"
    lines = out.getvalue().splitlines()
    assert lines[0] == "[1/4] a: ok (60s), ~3m left"
    assert lines[1] == "[2/4] b: no stems yet"
    assert lines[2] == "[3/4] c: FAILED boom (120s), ~1m left"
    assert lines[3] == "[4/4] d: ok (30s)"


def test_failure_keeps_the_whole_error(tmp_path):
    status = progress.failure(tmp_path / "song", "Traceback\n  line\nValueError: bad\n")
    assert status.startswith("FAILED ValueError: bad") and str(tmp_path / "song" / "error.log") in status
    assert (tmp_path / "song" / "error.log").read_text().startswith("Traceback")


def test_log_writes_what_it_prints(tmp_path, capsys):
    log = progress.Log(tmp_path / "x" / "train.log")
    log("step", 1, "loss", 0.5)
    assert capsys.readouterr().out == "step 1 loss 0.5\n"
    assert (tmp_path / "x" / "train.log").read_text() == "step 1 loss 0.5\n"
