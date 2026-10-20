"""Vocal stem separation (Mel-Band RoFormer by Kimberley Jensen, best vocal SDR in audio-separator's list)."""

import subprocess
from functools import cache
from pathlib import Path

from tunestudio_training import paths

MODEL = "vocals_mel_band_roformer.ckpt"


@cache
def _separator(output_dir: str):
    from audio_separator.separator import Separator

    # audio-separator downloads the model into TST_MODELS on first use.
    sep = Separator(model_file_dir=str(paths.models()), output_dir=output_dir, output_format="FLAC", log_level=30)
    sep.load_model(MODEL)
    return sep


def vocals(audio: str, work: Path) -> Path:
    """Separate once, then reuse `vocals.flac` / `instrumental.flac` from the work dir."""
    out = work / "vocals.flac"
    if out.exists():
        return out
    # The separator reads through libsndfile, which can't open m4a/aac; give it a decoded copy.
    mix = work / "mix.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", audio, "-ar", "44100", "-ac", "2", str(mix)], check=True)
    sep = _separator(str(work))
    files = sep.separate(str(mix), {"Vocals": "vocals", "Other": "instrumental"})
    mix.unlink()
    produced = {Path(f).stem: work / Path(f).name for f in files}
    if "vocals" not in produced:
        raise RuntimeError(f"separation produced {files}")
    return out
