import json

import pytest

from tunestudio_training import paths, splits
from tunestudio_training.pipeline import ultrastar

from conftest import SIMPLE, write_chart


def test_original_leaves_out_added_songs(tiny_splits):
    tiny_splits(
        {"train": ["A - 1", "B - 2", "C - 3"]},
        manifest={"A - 1": {"split": "train"}, "B - 2": {"split": "train", "added": "2026-10-01T00:00:00"}},
    )
    assert splits.songs("train") == ["A - 1", "B - 2", "C - 3"]
    # Not in the manifest at all counts as added.
    assert splits.songs("train", original=True) == ["A - 1"]


def test_check_disjoint(tiny_splits):
    tiny_splits({"train": ["A - 1"], "dev": ["B - 1"], "test": ["C - 1"]})
    splits.check_disjoint()
    tiny_splits({"train": ["A - 1"], "dev": ["B - 1"], "test": ["A - 1"]})
    with pytest.raises(SystemExit, match="overlap"):
        splits.check_disjoint()


def test_usable(tmp_path):
    ok = write_chart(tmp_path / "ok", SIMPLE)
    assert splits.usable(tmp_path / "ok") == ok
    write_chart(tmp_path / "duet", SIMPLE, duet=True)
    assert splits.usable(tmp_path / "duet") is None
    write_chart(tmp_path / "rel", SIMPLE, headers={"RELATIVE": "yes"})
    assert splits.usable(tmp_path / "rel") is None
    write_chart(tmp_path / "two", SIMPLE)
    write_chart(tmp_path / "two", SIMPLE, name="other")
    assert splits.usable(tmp_path / "two") is None
    bpm = write_chart(tmp_path / "bpm", SIMPLE)
    bpm.write_text(bpm.read_text().replace("E\n", "B 10 200\nE\n"))
    assert splits.usable(tmp_path / "bpm") is None
    (tmp_path / "none").mkdir()
    assert splits.usable(tmp_path / "none") is None


@pytest.mark.parametrize(
    "artist, primary",
    [
        ("Queen", "queen"),
        ("Lady Gaga feat. Beyoncé", "lady gaga"),
        ("Simon & Garfunkel", "simon"),
        ("A ft B", "a"),
        ("Tiësto vs. X", "tiësto"),
        ("Sido und Andreas Bourani", "sido"),
        ("Alpha, Beta", "alpha"),
        ("Major Lazer x DJ Snake", "major lazer"),
    ],
)
def test_primary_artist(tmp_path, artist, primary):
    song = ultrastar.Song(headers={"ARTIST": artist})
    assert splits.primary_artist(song, tmp_path / "X - Y") == primary


def test_primary_artist_from_the_folder(tmp_path):
    assert splits.primary_artist(ultrastar.Song(), tmp_path / "Folder Artist - Title") == "folder artist"


def test_add_assigns_new_songs_and_moves_nothing(tmp_path, tiny_splits, capsys):
    lib = tmp_path / "library"
    for name, artist in (("Old - 1", "Old"), ("Tested - 1", "Tested"), ("Tested - 2", "Tested"), ("New - 1", "New")):
        write_chart(lib / name, SIMPLE, headers={"ARTIST": artist})
    write_chart(lib / "Duet - 1", SIMPLE, duet=True)
    write_chart(lib / "Lang - 1", SIMPLE)
    found = splits.scan()
    old_sha = found["Old - 1"]["sha1"]
    tiny_splits(
        {"train": ["Old - 1", "Gone - 1"], "test": ["Tested - 1"], "lang-x": ["Lang - 1"]},
        manifest={
            "Old - 1": {"artist": "old", "language": "english", "sha1": "changed", "split": "train"},
            "Gone - 1": {"artist": "gone", "language": "english", "sha1": "0", "split": "train"},
            "Tested - 1": {**found["Tested - 1"], "split": "test"},
        },
    )
    splits.add()
    out = capsys.readouterr().out
    assert splits.songs("train") == ["Gone - 1", "New - 1", "Old - 1"]  # sorted, nothing moved
    assert splits.songs("test") == ["Tested - 1", "Tested - 2"]  # the artist is in test
    manifest = json.loads((paths.SPLITS / "manifest.json").read_text())["songs"]
    assert manifest["New - 1"]["split"] == "train" and "added" in manifest["New - 1"]
    assert manifest["Old - 1"]["sha1"] == "changed" != old_sha
    assert "1 charts changed" in out and "Old - 1" in out
    assert "not in the library" in out and "Gone - 1" in out
    assert "Lang - 1" not in manifest and "Duet - 1" not in manifest


def test_committed_splits_are_consistent():
    """The frozen splits in the repository: train, dev and test disjoint, every list song in the manifest with its
    split, and the language sets outside train, dev and test."""
    lists = {f.stem: set(splits.songs(f.stem)) for f in paths.SPLITS.glob("*.txt")}
    train, dev, test = lists["train"], lists["dev"], lists["test"]
    assert not (train & dev or train & test or dev & test)
    manifest = json.loads(splits.manifest_path().read_text())["songs"]
    for split in ("train", "dev", "test"):
        assert all(manifest[s]["split"] == split for s in lists[split]), split
    assert lists["sel"] <= train
    for name, songs in lists.items():
        if name.startswith("lang-"):
            assert not songs & (train | dev | test), name
    assert len(splits.songs("train", original=True)) == 669
