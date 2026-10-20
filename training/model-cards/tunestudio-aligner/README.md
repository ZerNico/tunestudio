---
license: cc-by-nc-4.0
base_model: MahmoudAshraf/mms-300m-1130-forced-aligner
library_name: onnx
pipeline_tag: automatic-speech-recognition
tags:
  - forced-alignment
  - singing
  - lyrics-alignment
  - ultrastar
  - onnx
---

# Tune Studio aligner

A CTC forced aligner for **sung** lyrics, plus a small head that finds where syllables start. Made for
Tune Studio, which times lyrics to a vocal stem to make UltraStar karaoke charts.

- `aligner.onnx`: [MahmoudAshraf/mms-300m-1130-forced-aligner](https://huggingface.co/MahmoudAshraf/mms-300m-1130-forced-aligner)
  (Meta's MMS-300m wav2vec2, a speech aligner) fine-tuned on singing.
- `boundary.onnx`: a syllable-start head that reads the aligner's last hidden layer.
- `vocab.json`, `tokenizer_config.json`, `config.json`: the aligner's vocabulary and configuration, unchanged from the base model.

## Use

**aligner.onnx**: input `audio` `[batch, samples]` float32, 16 kHz mono, raw (not normalized). Outputs `logits`
`[batch, frames, 31]` (CTC, before log-softmax; ctc-forced-aligner appends a 32nd, all-zero `<star>` column
after the log-softmax) and `hidden` `[batch, frames, 1024]`, one frame per 20 ms (320
samples). Run a song in 30 s windows with 2 s of context on each side, the way
[ctc-forced-aligner](https://github.com/MahmoudAshraf97/ctc-forced-aligner) does (`generate_emissions`), and keep
each window's middle 30 s. Text is romanized and tokenized as in ctc-forced-aligner.

**boundary.onnx**: input `hidden` `[1, frames, 1024]`, the aligner's hidden states for the **whole song** (the
windows joined). Output `probs` `[1, frames]`: the probability that a syllable starts in each 20 ms frame. Tune
Studio moves each aligned syllable start to a peak (≥ 0.3) within ±0.3 s, assigning each peak to at most one
syllable in order.

## Training

- Aligner: 6000 steps at learning rate 6e-5 (cosine schedule) on batches of 120 s of audio, feature encoder frozen,
  on about 39,000 sung lines from the hand-made UltraStar charts of 669 songs (the train split), with CTC targets
  from the lyrics. The checkpoint with the best validation loss is kept (step 4000). Held-out CTC loss 2.81 → 0.77.
- Boundary head: Linear → bidirectional GRU (192) → Linear, trained on the same songs to predict the charts'
  syllable starts (Gaussian targets, σ = 20 ms). On held-out songs, 79.6% of chart syllable starts have a peak
  within ±40 ms and 94.0% within ±80 ms.

## Results

Measured once on 74 held-out songs, English and German, against their hand-made charts: Tune Studio's chart
pipeline today (this aligner, the boundary head, the note refiners and some rule changes) vs. its first version
(the stock aligner, no learned steps):

| | first version | today | songs better / worse |
|---|---|---|---|
| syllable F1 | 0.788 | 0.875 | 66 / 6 |
| note F1 | 0.609 | 0.698 | 67 / 5 |
| frame F1 | 0.526 | 0.589 | 60 / 10 |
| exact pitch | 0.792 | 0.851 | 69 / 4 |

On its own (same pipeline otherwise, 58 development songs), the fine-tuned aligner raised syllable F1 by 0.047 and
note F1 by 0.029, and the boundary head on top of it syllable F1 by another 0.026.

The first version was measured with syllable-splitting tables that had seen the test charts; today's tables
were built from the training songs only. That flatters the first version, so the gain is, if anything,
understated.

The ONNX files were checked against the PyTorch models: identical CTC alignment paths and syllable-start peaks on
full songs.

## License

CC BY-NC 4.0, inherited from the MMS base model: free for non-commercial use, with attribution.
