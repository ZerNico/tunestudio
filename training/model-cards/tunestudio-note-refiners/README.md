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

Three small gradient-boosted tree models (scikit-learn `HistGradientBoosting`, exported to ONNX) that correct notes
transcribed from a vocal stem and pick its golden notes, the way human UltraStar charters do. Made for Tune Studio.

- `notefix.onnx`: pitch corrections. Charters often write a note a semitone or two away from the sung pitch
  (slides, ornaments, intonation). Input `features` `[notes, 24]`; outputs `label` and `probabilities`
  `[notes, 5]` for shifts of -2, -1, 0, +1, +2 semitones (`notefix.json`). Tune Studio shifts a note when the
  most likely non-zero shift has probability ≥ 0.5. On held-out songs the corrected pitch matches the chart for 84.3% of
  notes.
- `ends.onnx`: note ends. Charters end notes earlier than the voice stops and leave a gap before the next one.
  Input `features` `[notes, 27]`; output `variable` `[notes, 1]`, seconds to add to each note's end. On held-out songs
  the end is off by 62 ms on average, against 144 ms without it.
- `golden.onnx`: golden notes (double points). Input `features` `[notes, 50]`; outputs `label` and `probabilities`
  `[notes, 2]`, the second how likely a charter makes the note golden. Tune Studio marks about as many golden notes
  as those probabilities add up to, the most likely first, starting each golden group on a syllable and spreading
  them over the song. On the songs used to test the pipeline, its golden notes match the charter's at F1 0.183
  (one to one, by onset or overlap), where two charters of one song agree at about 0.17.

The features are computed by Tune Studio from the pitch track, the note transcription and the neighbouring notes.
The refiners were trained on Tune Studio's own transcriptions of about 2,600 songs, the golden-note model on
2,302 of them, against those songs' hand-made UltraStar charts (none of the songs used to test the pipeline).

The ONNX files give the same decisions as the scikit-learn models: the refiners on all 1,229,604 notes of the
training data, the golden-note model on all 118 test songs (the same golden notes in every song).

## License

MIT.
