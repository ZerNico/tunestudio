---
license: mit
library_name: onnx
pipeline_tag: audio-classification
tags:
  - pitch-estimation
  - f0
  - singing
  - onnx
---

# FCPE (ONNX)

An ONNX export of the pitch estimator [FCPE](https://github.com/CNChTu/FCPE) by CN_ChiTu: the model bundled with
[torchfcpe](https://pypi.org/project/torchfcpe/) 0.0.4 (`fcpe_c_v001.pt`, SHA-256
`b9aeaeb673436eeda50ceafd632aa681aa63417e52eae4207503d180c9b10015`), unchanged. Exported for Tune Studio.

`fcpe.onnx`: input `audio` `[1, samples]` float32, 16 kHz mono. Output `f0` `[1, samples // 160 + 1]`, the pitch
in Hz every 10 ms, 0 where unvoiced. The mel spectrogram and the decoding are inside the graph, with
`decoder_mode="local_argmax"`, `threshold=0.006` and a ceiling of 1400 Hz. The spectrogram is computed with plain
convolutions rather than the STFT op, so every execution provider can run it.

Checked against torchfcpe on CPU on two full songs: voiced/unvoiced identical on every frame, and one frame in
17,953 differs by more than 1 cent (11 cents).

## License

MIT, like the original (see `LICENSE`).
