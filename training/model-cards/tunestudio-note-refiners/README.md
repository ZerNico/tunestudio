---
license: mit
library_name: onnx
tags:
  - singing
  - ultrastar
  - note-transcription
  - onnx
---

# Tune Studio note refiners

Two small gradient-boosted tree models (scikit-learn `HistGradientBoosting`, exported to ONNX) that correct notes
transcribed from a vocal stem, the way human UltraStar charters write them. Made for Tune Studio.

- `notefix.onnx`: pitch corrections. Charters often write a note a semitone or two away from the sung pitch
  (slides, ornaments, intonation). Input `features` `[notes, 24]`; outputs `label` and `probabilities`
  `[notes, 5]` for shifts of -2, -1, 0, +1, +2 semitones (`notefix.json`). Tune Studio shifts a note when the
  most likely non-zero shift has probability ≥ 0.5. On held-out songs the corrected pitch matches the chart for 84.3% of
  notes.
- `ends.onnx`: note ends. Charters end notes earlier than the voice stops and leave a gap before the next one.
  Input `features` `[notes, 27]`; output `variable` `[notes, 1]`, seconds to add to each note's end. On held-out songs
  the end is off by 62 ms on average, against 144 ms without it.

The features are computed by Tune Studio from the pitch track, the note transcription and the neighbouring notes.
Both were trained on Tune Studio's own transcriptions of about 2,600 songs, against those songs' hand-made
UltraStar charts (none of the songs used to test the pipeline).

The ONNX files give the same decisions as the scikit-learn models on all 1,229,604 notes of the training data.

## License

MIT.
