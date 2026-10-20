---
license: mit
library_name: onnx
tags:
  - beat-tracking
  - downbeat-tracking
  - music
  - onnx
---

# Beat This! (ONNX)

An ONNX export of the beat and downbeat tracker [Beat This!](https://github.com/CPJKU/beat_this) by Francesco
Foscarin, Jan Schlüter and Gerhard Widmer (ISMIR 2024): the `final0` checkpoint (SHA-256
`8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331`), unchanged. Exported for Tune Studio.

- `logmel.onnx`: input `audio` `[samples]` float32, 22.05 kHz mono. Output `spect` `[frames, 128]`, the model's
  log mel spectrogram, 50 frames per second. Computed with plain convolutions rather than the STFT op.
- `beat_this.onnx`: input `spect` `[1, frames, 128]`, one chunk of at most 1500 frames. Outputs `beat` and
  `downbeat` logits `[1, frames]`. The batch size is fixed at 1.

Split the spectrogram into chunks and join the predictions as `beat_this.inference.split_predict_aggregate` does
(chunks of 1500, borders of 6, keep the first prediction where chunks overlap). Then pick peaks as its minimal
postprocessor does: frames whose logit is above 0 and the maximum within ±3 frames, adjacent peaks merged,
downbeats moved to the nearest beat.

Checked against the PyTorch model on three songs: identical beats and downbeats.

## Citation

```bibtex
@inproceedings{foscarin2024beatthis,
  author = {Francesco Foscarin and Jan Schl{\"u}ter and Gerhard Widmer},
  title = {Beat This! Accurate Beat Tracking Without {DBN} Postprocessing},
  booktitle = {Proceedings of the 25th International Society for Music Information Retrieval Conference (ISMIR)},
  year = {2024},
  address = {San Francisco, CA, United States},
}
```

## License

MIT, like the original code and weights (see `LICENSE`).
