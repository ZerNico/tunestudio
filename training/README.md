# Tune Studio training

## What this is

Tune Studio can make an UltraStar chart from a song: notes, lyrics and timing that a karaoke game can play. Some steps
of that are models we trained ourselves, on hand-made charts from [USDB](https://usdb.animux.de). This folder rebuilds
those models, measures how good the charts get, and exports the files the app downloads.

You only need it to improve the models. The app downloads the finished ones from Hugging Face and never runs anything
from here.

It is a [uv](https://docs.astral.sh/uv/) project of its own (Python), outside the Bun workspaces. Its command is
`tst`. It also records the goldens and fixtures the app's charting tests compare against.

## How a chart is made

The app runs these steps for a song. The same steps live here in `src/tunestudio_training/pipeline/`, and the app's
code is a port of them.

1. **Vocals separated** from the music (Mel-Band RoFormer by Kimberley Jensen, used as released).
2. **Pitch tracked**: which note the singer sings every 10 ms (FCPE from torchfcpe, used as released).
3. **Beats found** and turned into one tempo for the chart (Beat This! by CPJKU, used as released, plus plain code).
4. **Lyrics fetched** from [LRCLIB](https://lrclib.net), with rough line times, and **split into syllables** (plain
   code with tables learned from charts).
5. **The aligner** finds when each character of the lyrics is sung. **Trained here.**
6. **The boundary head** moves each syllable start to where a charter would put it. **Trained here.**
7. **GAME** writes the notes of each line, keeping those syllable starts (by openvpi, used as released).
8. **The pitch corrector** fixes notes a charter would write a semitone or two away. **Trained here.**
9. **The note-end model** decides where each note ends. **Trained here.**
10. **Clean-up** (plain code): notes moved by octaves so the melody doesn't jump, line splits and line breaks.
11. **Golden notes** picked the way charters pick them ([gradient-boosted trees](#golden-notes-g1) and plain code).
    **Trained here.**

The models we ship, one Hugging Face repo per row group (under `tuneperfect/`):

| Repo                       | File                            | What it does                                   | Source                      | Technically                                                  | Checkpoint      | License      |
| -------------------------- | ------------------------------- | ---------------------------------------------- | --------------------------- | ------------------------------------------------------------ | --------------- | ------------ |
| `tunestudio-aligner`       | `aligner.onnx`                  | finds when each lyric character is sung        | trained here                | MMS-300m CTC forced aligner fine-tuned on sung lines         | `aligner-ft2`   | CC BY-NC 4.0 |
|                            | `boundary.onnx`                 | says where syllables start                     | trained here                | syllable-start head on the aligner's hidden states           | `b1`            | CC BY-NC 4.0 |
| `tunestudio-note-refiners` | `notefix.onnx`                  | moves notes to the pitch a charter would write | trained here                | pitch corrector (gradient-boosted trees)                     | `nf4`           | MIT          |
|                            | `ends.onnx`                     | ends notes where a charter would               | trained here                | note-end regressor (gradient-boosted trees)                  | `e3`            | MIT          |
|                            | `golden.onnx`                   | picks the notes a charter would make golden    | trained here                | golden-note classifier (gradient-boosted trees)              | `g1`            | MIT          |
| `fcpe-onnx`                | `fcpe.onnx`                     | the singer's pitch every 10 ms                 | torchfcpe, used as released | FCPE pitch, upstream weights, exported with mel and decoding | torchfcpe 0.0.4 | MIT          |
| `beat-this-onnx`           | `logmel.onnx`, `beat_this.onnx` | where the beats and downbeats are              | CPJKU, used as released     | Beat This! beats, upstream weights                           | `final0`        | MIT          |

The shipped checkpoints are the pipeline's defaults (`recipes.SHIPPED`: the aligner `aligner-ft2`, which is also the
boundary head's backbone, then b1, nf4, e3 and g1) and the ones the model cards in `model-cards/` describe. Exporting them
gives the shipped files byte for byte (`shipped.sha256` has their hashes). Notes come from GAME (openvpi's release,
CC BY-NC-SA 4.0 weights), which isn't retrained here.

## The models we train

### Aligner (`aligner-ft2`)

- **Problem:** to time a chart we need to know when each syllable is sung. A forced aligner does that: given audio
  and the words, it finds when each character happens. The stock aligner was trained on speech. Singing breaks it:
  a long held vowel ("baaaby"), a melisma (one syllable over several notes) or a breath makes it put words seconds
  off, so whole lines of notes start in the wrong place.
- **In and out:** a song's vocals (16 kHz audio) plus its lyrics → for every 20 ms of audio, how likely each
  character is. Tune Studio turns that into a start and end time for every character and word.
- **What it is:** Meta's MMS-300m speech model (a wav2vec2 network with 315 million parameters, in the version
  [ctc-forced-aligner](https://github.com/MahmoudAshraf97/ctc-forced-aligner) uses), fine-tuned on singing. It is a
  CTC model (explained in the glossary), so it learns from the lyrics alone, without anyone marking times.
- **Learned from:** about 39,000 sung lines (27 h of audio) from the hand-made charts of the 669 original train songs.
  Each line is cut from the separated vocals, and its lyrics are the target.
- **How much it helps:** on dev (58 songs), syllable timing (syllable_f1) +0.047 and notes (note_f1) +0.029 against
  the stock aligner, everything else the same.
- **In the app:** the app runs `aligner.onnx` on the vocals in 30 s windows and aligns the lyrics with it, in its
  native code.

### Boundary head (`b1`)

- **Problem:** the aligner learns which characters are sung, not where a charter puts a syllable's start. Its starts
  are often a little early or late, and a note that starts 100 ms off already misses the beat in the game.
- **In and out:** the aligner's internal view of the song (1024 numbers per 20 ms) → for every 20 ms, the probability
  that a syllable starts there. Tune Studio then moves each aligned syllable start to a nearby peak (within 0.3 s),
  each peak used once and the order kept.
- **What it is:** a small network on top of the frozen aligner: a linear layer, a bidirectional GRU (a recurrent
  network that reads the song forwards and backwards) of 192 units and a linear output, about 640,000 parameters.
- **Learned from:** the syllable starts in the hand-made charts of the same 669 songs' lines (starts of notes that
  aren't "~" continuations), softened by 20 ms so a charter being a frame off isn't punished hard. On held-out songs,
  79.6% of the charts' syllable starts have a peak within 40 ms and 94.0% within 80 ms.
- **How much it helps:** on dev, on top of the fine-tuned aligner: syllable_f1 +0.026, note_f1 +0.024, onset_f1
  +0.029. Assigning each peak to one syllable added note_f1 +0.010 and syllable_f1 +0.010.
- **In the app:** `boundary.onnx` reads the aligner's hidden states for the whole song, right after the alignment.

### Pitch corrector (`nf4`, "notefix")

- **Problem:** GAME transcribes the pitch the singer actually sings. Charters write the note the singer means: they
  smooth over slides and ornaments, ignore sloppy intonation and keep to the song's scale. So GAME's note is often a
  semitone or two away from the chart's, and the player is asked to sing a "wrong" note.
- **In and out:** each note's features (24 numbers: GAME's raw pitch, how the sung pitch moves inside the note, the
  song's scale, the neighbouring notes) → shift it by -2, -1, +1 or +2 semitones, or keep it. Tune Studio only shifts
  when the model is at least 50% sure.
- **What it is:** gradient-boosted decision trees (scikit-learn's `HistGradientBoostingClassifier`, 400 rounds).
- **Learned from:** the pipeline's own notes on 2,627 train songs, compared with the hand-made charts: 1,229,604
  notes, 835,436 of them with the chart's pitch over most of the note. On held-out songs the corrected pitch matches
  the chart for 84.3% of notes.
- **How much it helps:** the first version (nf1) on dev: pitch_exact +0.012 and combined +0.012. Training it on the
  pipeline's own notes of more songs (nf3, then nf4) was never worse and added combined +0.005.
- **In the app:** `notefix.onnx` runs on each line's notes after GAME.

### Note-end model (`e3`, "ends")

- **Problem:** GAME holds a note until the next one starts, the way the voice really carries on. Charters end notes
  earlier (by a median of 80 ms on dev) and leave a gap before the next note (a median of 115 ms). Without this,
  notes run into each other and are hard to read and to hit.
- **In and out:** the pitch corrector's 24 features plus the gaps to the neighbouring notes (27 numbers) → how many
  seconds to move the note's end.
- **What it is:** gradient-boosted decision trees (`HistGradientBoostingRegressor`).
- **Learned from:** the same notes as the pitch corrector: the 902,572 notes where a hand-made note starts within
  80 ms of ours, labelled with how much earlier or later the hand-made one ends. On held-out songs the end is off by
  62 ms on average, against 144 ms without it.
- **How much it helps:** the first version (e1) on dev: frame_f1 +0.045, pitch_exact +0.026, and notes with the right
  start, pitch and end (note_f1_off) from 0.37 to 0.62.
- **In the app:** `ends.onnx` runs after the pitch corrector.

### Golden notes (`g1`)

- **Problem:** golden notes (`*` in a chart) score double, and charters put them on the moments a singer shows off.
  Tune Studio used to mark them with a rule: 5% of the notes, at least 0.4 s long, the most steadily sung first.
  Charters' golden notes are mostly shorter than that (75% under 0.4 s): long for their song rather than long in seconds,
  high in their line, at the end of a line or phrase, and often a whole melisma. The rule finds few of them.
- **In and out:** each note's features (50 numbers: its length against the song, line, phrase and neighbours, how
  steadily and loudly it is sung, its pitch against the song, line, phrase and neighbours, its place in the line and
  phrase, its melisma) → how likely a charter gilds it. A song gets as many golden notes as those probabilities add
  up to, the most likely first, picked by plain rules (`pipeline.golden.pick`): a golden group always starts on a
  syllable, never on a "~" in the middle of a melisma, keeps the melisma together unless its tail is clearly less
  likely (`runs` 0.7), and no tenth of the song takes more than a quarter of the golden notes.
- **What it is:** gradient-boosted trees (scikit-learn `HistGradientBoostingClassifier`, 300 iterations of 31 leaves),
  exported to ONNX as `golden.onnx`. Its split thresholds are rounded down to float32 for the export, so that the
  ONNX file gives the same probabilities (within 3e-7) and the same golden notes on all 118 test songs.
- **Learned from:** the pipeline's notes of the 2,302 train songs of a dump run from 2026-10-09 (sel's songs and
  artists left out), labelled by whether they match a hand-made golden note.
- **How much it helps:** golden_f1 (golden notes matched one to one, by onset or overlap) from the shipped charts'
  0.097 to 0.158 on dev and from 0.130 to 0.198 on sel (means, 95% CIs of the gain +0.037 to +0.085 and +0.040 to
  +0.097), measured with m1, a logistic regression over the features, their squares and products (246 weights).
  The trees beat m2 (m1 with the pick below) on dev and sel together, 0.183 against 0.168 (CI of the gain +0.002 to
  +0.029), and tie it on held-out train artists, 0.193 against 0.197 (CI -0.011 to +0.002). Two charters of one song
  agree at about 0.17, so that is near the ceiling.
- **How it picks:** the first table (m1) could gild a lone "~" in the middle or at the end of a melisma ("deep~~[~]~"):
  17.6% of its golden groups on held-out train artists, 7.3% of a charter's. Starting every group on a syllable
  brings that to 1.2% and makes the golden notes look more like a charter's (the classifier's AUC 0.784 → 0.747),
  for golden F1 0.205 → 0.198 there (CI of the change -0.011 to -0.002, with the spread cap). On dev and sel (the
  same weights as m1, only the pick changed): 0.158 → 0.152 and 0.198 → 0.185 (CIs -0.018 to +0.005 and -0.027 to
  +0.000), plausibility AUC 0.84 → 0.79 and 0.77 → 0.76. Capping how many repeats of a line get golden notes
  (`repeat_cap`) is there but off: charters gild repeated lines about as often as the model (61% of their gilded
  lines are repeated lines, the model's 66%), and a cap of 3 costs F1 another 0.007.
- **Which data:** retraining m2 on today's pipeline changed nothing measurable: on the same 464 songs, the old
  run's notes and a new run's gave dev 0.152 and 0.154, sel 0.189 and 0.185 (m2 itself: 0.152 and 0.185). m2 gains
  nothing from more songs, the trees stop gaining at about 1,100, and bigger trees (800 iterations of 63 leaves,
  1,500 of 127) scored lower.
- **In the app:** `electron/charting/golden.ts` ports `pipeline.golden` (features and pick) and runs `golden.onnx`
  in the native addon for the probabilities. It runs last, on the finished lines, for whole songs (Chart range leaves
  golden notes alone). `{"golden": {"method": "rule"}}` charts with the old rule in `tst eval`. To ship other trees,
  train them, compare them, set `recipes.SHIPPED["golden"]`, export (`tst export tunestudio-note-refiners --golden-check
  dev/base`) and record the goldens again.

```bash
uv run tst golden train g2                # <models>/golden/g2.pkl, from the train/dump run, with PICK
uv run tst golden rescore dev base g2 --options '{"model": ".local/models/golden/g2.pkl"}'
uv run tst compare dev base g2            # golden_f1, golden_precision, golden_recall, golden_count_ratio
uv run tst golden plausibility dev base g2
```

`rescore` re-marks an eval run's charts without charting again. `plausibility` prints the style of a run's golden
notes next to the hand-made charts' (their share of the notes, length, how often they are the last, highest or
longest of their line, in runs, spread over the song) and the AUC of a classifier telling the two apart (0.5: it
can't). The rule scores 0.95 on dev, m1 0.84, m2's pick 0.79. The pick's options (`PICK`: "scale", "runs", "spread",
"start", "repeat_cap") are saved with the model and can be overridden in `--options`. With `--linear`, `train` fits
m2's logistic regression instead (a JSON table, to measure the trees against). Songs whose chart has no golden notes
(a tenth: the charter's style) are left out of the golden metrics.

### The models used as released

- **Mel-Band RoFormer** by Kimberley Jensen, used as released through
  [audio-separator](https://github.com/nomadkaraoke/python-audio-separator): separates the vocals from the music.
  Downloaded on first use.
- **FCPE** from torchfcpe 0.0.4, used as released (MIT): the singer's pitch every 10 ms. We export it to ONNX with
  its weights unchanged (`fcpe-onnx`).
- **Beat This!** by CPJKU, checkpoint `final0`, used as released (MIT): beats and downbeats. Exported with its weights
  unchanged (`beat-this-onnx`).
- **GAME** by openvpi, release 1.0.3 large, used as released (weights CC BY-NC-SA 4.0): writes the notes of a line
  given its audio and syllable starts. Not retrained here: fine-tuning it on the charts made it worse on every metric.
- **Syllable tables** (plain code): which syllables charters split common English and German words into, counted from the train
  charts (`tst syllables`), with vowel-group rules for other words. Data and rules, no model.

## Glossary

- **Library**: your folder of songs, one folder per song with a hand-made chart (`.txt`) and its audio, as
  [USDB Syncer](https://github.com/bohning/usdb_syncer) downloads them.
- **Splits**: the songs divided once and for all into groups, by artist so one voice is never in two of them. **train**
  is what models learn from. **dev** is what every decision is measured on. **test** is locked, used once for a final
  report. **sel** is a second set of train songs for checking decisions next to dev.
- **Stems**: a song's separated vocals (`vocals.flac`) and pitch track (`pitch.npz`). Everything else starts from them.
- **Clips**: one short audio file per chart line, cut from the vocals. The aligner and the boundary head learn from them.
- **Dataset**: what a model learns from, built from the stems and the charts (clips plus their targets, or the notes
  table of the note refiners).
- **Checkpoint**: a trained model as a file or folder, named like `aligner-ft2`, `b1`, `nf4`, `e3`.
- **Eval run**: every song of a split charted with the full pipeline and scored against its hand-made chart
  (`tst eval`). Comparing two runs tells whether a change helps.
- **Export / ONNX**: ONNX is a file format any language can run models from. Exporting turns a checkpoint into the
  files the app downloads.
- **Goldens**: every step's inputs and outputs for a few real songs, recorded here, so the app's tests can check its
  port step by step. They contain lyrics, so they never go into git.
- **Fixtures**: small generated files the app's tests compare against (word lists, tables), committed in the app.
- **CTC**: a way to train a speech model from text alone. The model outputs, every 20 ms, how likely each character
  is, and CTC scores whether the characters come out in the right order. A forced aligner then finds the best timing
  of known text in those outputs.
- **CUDA / MPS**: running on an NVIDIA graphics card (CUDA) or on an Apple Silicon Mac's GPU (MPS). Training is much
  faster on either than on the CPU.

## Quick start

```bash
cd training
uv sync                                    # Python 3.12, torch, the dev tools (pytest, ruff)
uv run tst init --library ~/path/to/songs  # writes tst.toml: where your songs, data, models and runs live
uv run tst status                          # what's there and the next step for each model
uv run tst doctor                          # ffmpeg, torch and its devices, GAME, disk space, git
```

`tst init` takes `--library` once per folder of songs, `--stems` for folders of stems you already have, and `--data`,
`--models` and `--runs` if they shouldn't live in the git-ignored `training/.local/`. It writes `training/tst.toml`
(it refuses to replace one without `--force`). `tst status` shows each setting and where it came from, then a row each
for the library, stems per split, datasets, checkpoints, eval runs and exports, and the next step for each model.
`tst doctor` prints `ok`, `note` or `PROBLEM` per check and exits with 1 on a problem.

Needs `ffmpeg` on PATH. The trained checkpoints (`aligner-ft2`, `b1`, `nf4`, `e3`) aren't public: put them under
`<models>` as in [Configuration](#configuration). GAME is openvpi's release, unzipped into
`<models>/game/GAME-1.0.3-large-onnx/`.

To check that everything works without training anything:

```bash
uv run tst stems dev --part 0/58          # one dev song's stems, about 40 s (skip it if you have stems)
uv run tst export all --verify            # about 1 min on an M5 Pro
uv run tst eval dev smoke --limit 1       # charts and scores the first dev song, about 70 s
```

`export --verify` ends with `model files identical to the shipped ones`. Without a notes dataset it says the
refiners' exports go unchecked, which is fine. The eval prints `[1/1] <song>: ok (69s)` and writes the chart and its
scores to `<runs>/eval/dev/smoke/<song>/`.

## Hardware and time

Measured on a MacBook with an M5 Pro and 24 GB of memory, and on a PC with an RTX 4070 Ti, unless marked as an
estimate. "Mac MPS" is the Mac's GPU.

| Task                                     | Mac CPU                          | Mac MPS                  | PC CUDA               |
| ---------------------------------------- | -------------------------------- | ------------------------ | --------------------- |
| stems (`tst stems`), per song            |                                  | ~40 s                    | not measured          |
| clips of the 669 train songs             | 9 min                            |                          | not measured          |
| aligner targets / boundary starts        | 20 s / 10 s                      |                          |                       |
| aligner, 6000 steps                      | 14.6 s a step, ~24 h (estimate)  | 3.2-3.6 s a step, ~5.5 h | ~32 min               |
| boundary head, 4000 steps                | 1.95 s a step, ~2.2 h (estimate) | 0.45 s a step, ~30 min   | 0.2 s a step, ~15 min |
| pitch corrector / note-end model         | ~3 min / ~1 min                  |                          |                       |
| eval, per song                           | 60-70 s, dev ~1 h (estimate)     |                          |                       |
| eval of all train songs for the refiners | ~2 days (estimate)               |                          |                       |
| export of all four repos                 | ~1 min                           |                          |                       |

Training uses about 10 GB of the Mac's memory on MPS. Evaluation and exports always run on the CPU or CUDA, so their
results don't depend on the Mac's GPU.

## Improving a model, step by step

The worked example is a new pitch corrector, `nf5`. The other models follow the same pattern. `tst rebuild <model>
<name> --dry-run` shows what a model's training is still missing.

1. **Stems** for the train songs (resumable, `--part 0/2` and `--part 1/2` share the work between two terminals):
   ```bash
   uv run tst stems train dev
   ```
2. **The dump run**: chart every train song and keep each note's features before any correction. This is the long
   step (see the table above). It is resumable: run the same command again after a stop.
   ```bash
   uv run tst eval train dump --dump-notes
   ```
3. **The dataset**: label those notes against the hand-made charts.
   ```bash
   uv run tst dataset notes            # --run train/dump (default)
   ```
4. **Train.** It prints a report on 15% of the songs it held out, per confidence threshold.
   ```bash
   uv run tst train notefix nf5
   ```
5. **Measure on dev**, the shipped pipeline (`base`) against the same pipeline with the new model:
   ```bash
   uv run tst eval dev base
   uv run tst eval dev nf5 --options '{"notefix": ".local/models/notefix/nf5.pkl"}'
   uv run tst compare dev base nf5 --by-language
   ```
6. **Decide** with the [judging rules](#judging-whether-a-change-is-better). If it's better, make it the default in
   `recipes.SHIPPED`, export it (`tst export tunestudio-note-refiners --notefix .local/models/notefix/nf5.pkl`) and
   measure it once on test.

`tst rebuild notefix nf5` runs steps 1 to 4 for you, skipping what's there and up to date, and prints the commands of
step 5. It never runs them itself, and never replaces a checkpoint without `--force` (it says so when a name is a
shipped one).

**Note-end model**: the same, with `tst train ends e4` and `--options '{"ends_model": ".local/models/ends/e4.pkl"}'`.

**Aligner**: clips of the original train songs (one per chart line, the chart shifted onto our audio, broken lines
dropped, ~39,000 clips or 27 h) and of dev (every 4th line), CTC targets from the lyrics, then 6000 steps at lr 6e-5
(cosine) on batches of 120 s of audio with the feature encoder frozen, the best validation loss kept (ft2: step 4000,
~32 min on an RTX 4070 Ti):

```bash
uv run tst dataset clips            # --all: every train song instead of the original 669
uv run tst dataset aligner
uv run tst train aligner aligner-ft3
TST_ALIGNER=.local/models/aligner/aligner-ft3 uv run tst eval dev ft3
uv run tst compare dev base ft3 --by-language
```

A `--limit N` build of the clips is a smoke build (for trying things out): `tst status` flags it and training refuses
it without `--allow-smoke`. Training writes its output to `train.log` in the checkpoint folder too. Ctrl-C a long run
and `tst train aligner <name> --resume` carries on from the last validation (every 500 steps).

**Boundary head**: the charts' syllable starts per clip, a BiGRU head over the frozen aligner, 4000 steps at lr 1e-3.
The head finds its aligner by name under `<models>/aligner/`:

```bash
uv run tst dataset boundary
uv run tst train boundary b2 --backbone aligner-ft3
uv run tst eval dev b2 --options '{"boundary_model": ".local/models/boundary/b2.pt"}'
```

**Training the aligner and the head overnight on a Mac (MPS)**. The training is the same as on CUDA (see
[GPU and Apple Silicon](#gpu-and-apple-silicon)). Whether a model trained this way is as good is checked end to end,
against the shipped ones, with the clips they were trained on. About 5.5 h for the aligner, 30 min for the head and
1 h for each dev eval on a 24 GB M5 Pro:

```bash
uv run tst train aligner aligner-mps --device mps \
  && uv run tst train boundary b-mps --device mps --backbone aligner-mps \
  && uv run tst eval dev base \
  && TST_ALIGNER=.local/models/aligner/aligner-mps uv run tst eval dev mps \
    --options '{"boundary_model": ".local/models/boundary/b-mps.pt"}' \
  && uv run tst compare dev base mps --by-language
```

It passes when the 95% CIs of the primary metrics include 0, none is worse by 0.01 or more, and no language is clearly
worse. Then `devices.train = "auto"` can prefer MPS.

### What the eval runs share

`--options` take the learned steps' checkpoints (`notefix`, `boundary_model`, `ends_model`, where `null` switches a
step off) and `game_model`. A new aligner goes in with `TST_ALIGNER`. Runs of a split share stems, beats, lyrics and
alignments, so two runs differ only where their models do. A failed song keeps its whole error in `error.log` in its
folder. Lyrics come from LRCLIB (cached per song), the chart's text when LRCLIB has none. The PoC (the prototype this
project grew out of) also transcribed the vocals with Whisper to pick among LRCLIB's versions of a song (dev lyric WER
0.192 → 0.178). Whisper isn't part of this project, so a cached transcript (`whisper.json`, from the PoC's runs) picks
the version when there is one, else the version closest in length does.

## Judging whether a change is better

`tst compare` pairs the songs of two runs and prints, per metric, both medians, the median per-song difference, a 95%
confidence interval of the mean difference (bootstrap: how sure we are the difference isn't luck) and how many songs
got better or worse. Each metric compares our chart with the hand-made one, from 0 (nothing right) to 1, octaves
ignored like the game does:

- **frame_f1** (primary): how much note time has the right pitch, counting both missing time and extra time, so notes
  that are too long cost as much as notes that are too short.
- **note_f1** (primary): notes matched one to one with the chart's, by start (within 100 ms) and pitch.
- **pitch_exact** (primary): where both charts have a note, how often the pitch is the same.
- **syllable_f1**: syllable starts within 100 ms, pitch ignored. The lyric timing.
- **onset_f1**: note starts within 100 ms, pitch ignored.
- **note_f1_off**: like note_f1, and the note must also end in the right place.
- **combined**: hand-made note time we cover with the right pitch. It only counts what we miss, so it rewards notes
  that run on too long.
- **recall** / **precision**: hand-made note time we cover at all / our note time that is inside a hand-made note.
- **pitch_within1**: like pitch_exact, within one semitone. **note_count_ratio**: our notes / the chart's.

The rules:

- Better means: on dev, the 95% bootstrap CI of the mean difference excludes 0 and the mean gain is at least 0.01 for
  the primary metrics, and no language gets clearly worse (`--by-language`). Re-exporting the same weights already
  moves metrics by up to ~0.01. Changes below the bar that are never worse (nf3/nf4) were adopted on dev + sel.
- Test once, at the end. Don't tune or pick checkpoints on it.
- Compare runs from the same machine only: CUDA (fp16 aligner) and CPU don't give bit-identical charts.

## Reference

### Configuration

Each setting comes from its variable, else `training/tst.toml` (git-ignored, `tst init` writes it, `--config` or
`TST_CONFIG` name another file), else the default in the git-ignored `training/.local/`. Relative paths in the file are
relative to the file. Lists are TOML lists in the file and `:`-separated in variables (`;` on Windows). `tst status`
shows every value and where it came from.

| `tst.toml`       | Variable            | Default                               | What                                                                                                                                                                                          |
| ---------------- | ------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths.library`  | `TST_LIBRARY`       | `.local/library`                      | song library roots: one folder per song with its chart and audio                                                                                                                              |
| `paths.data`     | `TST_DATA`          | `.local/data`                         | vocal stems (`stems/<song>/`) and datasets                                                                                                                                                    |
| `paths.stems`    | `TST_STEMS`         |                                       | more `<song>/vocals.flac` + `pitch.npz` folders to reuse                                                                                                                                      |
| `paths.models`   | `TST_MODELS`        | `.local/models`                       | `aligner/<name>/`, `boundary/<name>.pt`, `notefix/<name>.pkl`, `ends/<name>.pkl`, `game/GAME-1.0.3-large-onnx/` (openvpi's release, unzipped), the separation model (downloaded on first use) |
| `paths.runs`     | `TST_RUNS`          | `.local/runs`                         | evaluation runs, exports, goldens                                                                                                                                                             |
| `models.aligner` | `TST_ALIGNER`       | `<models>/aligner/aligner-ft2`        | the aligner the pipeline uses                                                                                                                                                                 |
| `models.game`    | `TST_GAME`          | `<models>/game/GAME-1.0.3-large-onnx` | GAME's ONNX models                                                                                                                                                                            |
| `devices.train`  | `TST_DEVICE`        | `auto`                                | training device: `auto` (CUDA when there is one, else CPU), `cuda`, `mps`, `cpu`                                                                                                              |
| `devices.onnx`   | `TST_ORT_PROVIDERS` | `["CPUExecutionProvider"]`            | GAME's ONNX Runtime providers (comma-separated in the variable)                                                                                                                               |
|                  | `TST_ONNX`          |                                       | run the learned models from an export folder, as the app does (`--onnx` sets it). Never in the file: it changes what a run measures                                                           |

### Data and splits

The library is hand-made UltraStar charts with their audio, as USDB Syncer downloads them (English and German so
far). Use what's local first and sync more only when a model is shown to be data-limited. Charts, lyrics, audio,
stems, datasets, checkpoints and goldens never go into git: they stay in `.local/` (or wherever the settings point).

`splits/` is frozen and committed (song folder names and chart hashes only), grouped by primary artist:

| Split                 | Songs | Used for                                                                                                 |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| train                 | 2,667 | training. The first 669 (no `added` stamp in `manifest.json`) are what the aligner and boundary head saw |
| dev                   | 58    | every model decision. Other songs by these artists are in train, so dev is slightly optimistic           |
| test                  | 80    | **locked**, artists in no other split: only the final report of a model already chosen                   |
| sel                   | 60    | train songs used as a second tuning set next to dev                                                      |
| lang-&lt;language&gt; | 12-30 | evaluation sets for other languages, never in train/dev/test                                             |

Nothing moves between splits: `tst splits add` assigns songs new in the library (to test if their artist is there,
else train) and reports charts that changed since. Datasets record their songs with chart hashes and the manifest's
hash, and the clips record what they were built with in `build.json`.

### GPU and Apple Silicon

`tst train` uses CUDA when there is one, else the CPU (`devices.train = "auto"`), which is what the shipped models
were trained with. On Windows, `uv sync` installs torch with CUDA from the PyTorch index (PyPI only has CPU builds for
Windows), and `tst doctor` says when the installed torch has no CUDA. Linux wheels from PyPI include CUDA. The vocal
separation (`tst stems`) uses the same torch, so it runs on the GPU too.

On an Apple Silicon Mac, `--device mps` (or `devices.train = "mps"`) trains the aligner and the boundary head on the
GPU. The recipe doesn't change with the machine: the same 120 s batches, loss and updates everywhere. Where memory is
short (MPS, and Mac CPUs under 40 GB), each batch runs as micro-batches whose gradients add up to the whole batch's,
with gradient checkpointing (activations recomputed instead of kept). The micro-batch is the longest of 60, 30, 20 and
15 s that fits in the memory free when training starts (other apps count), `--micro-batch-seconds` picks it by hand,
and `train.log` and `train_info.json` record it. The gradients equal one pass over the batch to float32 rounding, and
a seeded CPU run with checkpointing gives bit for bit the weights of one without.

Checked on 20 songs' clips (1,196 lines), 200 aligner steps from the same seed and batches: the validation loss before
training is the same on MPS and the CPU (3.0391), the training losses at steps 50, 100, 150 and 200 agree within 3%
(MPS 1.2376, 0.4099, 0.3277, 0.3976, CPU 1.2372, 0.4015, 0.3187, 0.4023), and the final validation loss is 1.8836 on
MPS against 1.8401 on the CPU. 300 boundary-head steps: 90.1% of syllable starts within 80 ms on MPS, 89.6% on the
CPU. Whether a full MPS-trained aligner is as good is what the overnight check above decides.

### Exporting

```bash
uv run tst export all --verify
```

Writes `<runs>/export/<repo>/` with the ONNX files, the aligner's tokenizer files, `notefix.json` and the model card
and license from `model-cards/<repo>/`, and checks every export against the original (CTC paths and peaks for the
aligner, decisions for the refiners on the notes dataset, beats for Beat This!, frames for FCPE) on the vocals of the
first dev song with stems (`--check` takes others). `--verify` then compares the model files (ONNX, `notefix.json`, the
tokenizer files, licenses) with `shipped.sha256` and fails on any difference: exporting the shipped checkpoints gives
byte-identical files. The model cards (`README.md`) are left out of that check and reported when they differ: they are
edited in `model-cards/` between releases. Upload to the Hugging Face repos private first, and make them public after
review.

### Testing

```bash
bun run test:training     # from the repository root: uv run pytest, the fast suite (seconds, no data needed)
bun run lint:training     # ruff check and ruff format --check
uv run pytest -m slow     # needs the real library, models and stems: each test skips with a reason otherwise
```

The fast suite runs offline on synthetic songs, stems and a tiny random aligner. CI runs it with ruff whenever
`training/` or the app's generated tables change (`.github/workflows/training.yaml`). The slow tests export every repo
and compare with `shipped.sha256`, chart a dev song and check MPS training against the CPU.

To check that a change to the code makes the same files, fingerprint the outputs before and after (`.npz` by array,
`.gz` decompressed, JSON by content):

```bash
uv run tst fingerprint .local/data/clips .local/data/aligner --save /tmp/before.json
uv run tst fingerprint .local/data/clips .local/data/aligner --compare /tmp/before.json
```

### Goldens and fixtures for the app

The app's charting code is a port of `tunestudio_training.pipeline`. Its tests compare against goldens recorded here
(every stage call of a real song on the ONNX path, lyrics included, so never committed):

```bash
uv run tst eval dev onnx --onnx .local/runs/export     # caches: stems, pitch, beats, lyrics
uv run tst goldens "Glasperlenspiel - Echt" --cached .local/runs/eval/dev/onnx --onnx .local/runs/export
cd ../apps/studio && TUNESTUDIO_CHART_GOLDENS=../../training/.local/runs/goldens \
  TUNESTUDIO_CHART_MODELS=../../training/.local/runs/export TUNESTUDIO_CHART_GAME=<GAME ONNX dir> \
  bunx vitest run electron/charting
```

The goldens the app was ported against used GAME re-exported from the pretrained checkpoint (`--game`), which gives
byte-identical charts to openvpi's release. Generated files the app commits (no lyrics: words and tables):

```bash
uv run tst syllables    # apps/studio/electron/charting/data/syllables-{english,german}.json, from the train split
uv run tst fixtures     # data/aligner-text.json and fixtures/{aligner-text,syllables,numpy}.json
```

Both sample words from the whole library, so they reproduce only on the same library.

### Results

Dev (58 songs), medians, each step on top of the previous ones:

| Change                                                            | Result                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| aligner fine-tuned on singing (ft2)                               | syllable_f1 +0.047, note_f1 +0.029, combined +0.011 (all CIs > 0)                      |
| pitch corrector (nf1, GAME on jittered hand-made syllables)       | combined +0.012, pitch_exact +0.012                                                    |
| boundary head (b1, nearest peak ±120 ms)                          | combined +0.016, note_f1 +0.024, onset_f1 +0.029, syllable_f1 +0.026                   |
| learned note ends (e1)                                            | frame_f1 +0.045, pitch_exact +0.026, note_f1_off 0.37 → 0.62                           |
| one-to-one start assignment instead of nearest peak (±200 ms)     | note_f1 +0.010, onset_f1 +0.013, syllable_f1 +0.010                                    |
| assignment cost 0.5, then radius 0.3 (dev / sel)                  | cost: note_f1 +0.004 / +0.005, syllable_f1 +0.007, radius: syllable_f1 +0.002 / +0.003 |
| backing vocals "(...)" left out of the lyrics (dev / sel)         | note_f1 +0.006 / +0.012, sel syllable_f1 +0.019, recall -0.004 / -0.006                |
| refiners on the pipeline's own notes, more songs (nf3/e2, nf4/e3) | never worse: frame_f1 +0.003, then combined +0.005, recall +0.006                      |

Test, measured once (2026-10-12, 74 songs): the first pipeline (stock MMS aligner, no learned steps) vs the shipped
one: frame_f1 0.526 → **0.589**, note_f1 0.609 → **0.698**, pitch_exact 0.792 → **0.851**, syllable_f1 0.788 →
**0.875** (60/10, 67/5, 69/4, 66/6 songs better). The first pipeline's syllable tables had seen the test charts, so the
gain is if anything understated.

Tried and dropped: fine-tuning GAME on the charts (learns the charters' sparse coverage but places gaps imprecisely,
worse on every metric), longer or faster aligner training (snapshots up to 12k steps ≈ ft2, lr 1e-4 worse), boundary
heads trained on the bigger dataset (over-split), learned merging of `~` notes, best of several GAME samples.

### Licenses

The aligner and boundary head inherit CC BY-NC 4.0 from MMS (free for non-commercial use, with attribution). The note
refiners are MIT, FCPE and Beat This! MIT like their originals. GAME's weights are CC BY-NC-SA 4.0. This code is MIT,
like the rest of the repository.
