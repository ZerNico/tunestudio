import json

import httpx
import pytest

from tunestudio_training.pipeline import lrclib


def test_parse_lrc():
    lines = lrclib.parse_lrc("[00:01.50] Hello\n[01:02] world\n[00:03.00]   \nnot a line\n[ar:Artist]")
    assert [(x.start, x.text) for x in lines] == [(1.5, "Hello"), (62.0, "world")]


def test_versions_from_the_cache_closest_first(tmp_path):
    cache = tmp_path / "lrclib.json"
    cache.write_text(
        json.dumps(
            [
                {"duration": 200, "syncedLyrics": "[00:01.00] far"},
                {"duration": 181, "syncedLyrics": "[00:01.00] close"},
                {"duration": 180.5, "syncedLyrics": None},
                {"duration": 300, "syncedLyrics": "[00:01.00] too far"},
            ]
        )
    )
    found = lrclib.versions("A", "T", 180, cache)
    assert [v[0].text for v in found] == ["close", "far"]
    assert lrclib.search("A", "T", 180, cache)[0].text == "close"
    assert lrclib.search("A", "T", 190, cache) is None  # nothing within 4 s


def test_fetch_retries_server_errors(monkeypatch):
    answers = [httpx.Response(500), httpx.Response(503), httpx.Response(200, json=[{"id": 1}])]
    calls, sleeps = [], []
    monkeypatch.setattr(lrclib.httpx, "get", lambda *a, **k: calls.append(k["params"]) or answers.pop(0))
    monkeypatch.setattr(lrclib.time, "sleep", sleeps.append)
    assert lrclib._fetch("A", "T") == [{"id": 1}]
    assert len(calls) == 3 and sleeps == [5, 10]
    monkeypatch.setattr(lrclib.httpx, "get", lambda *a, **k: httpx.Response(404))
    assert lrclib._fetch("A", "T") == []


def test_fetch_raises_after_network_errors(monkeypatch):
    def fail(*a, **k):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(lrclib.httpx, "get", fail)
    monkeypatch.setattr(lrclib.time, "sleep", lambda s: None)
    with pytest.raises(httpx.ConnectError):
        lrclib._fetch("A", "T", attempts=3)
