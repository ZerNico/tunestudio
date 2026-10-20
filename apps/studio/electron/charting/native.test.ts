/**
 * The native addon's chart functions against the PoC on real songs. Local only: needs the goldens
 * (TUNESTUDIO_CHART_GOLDENS), the exported models (TUNESTUDIO_CHART_MODELS, a `tst export` folder) and a built addon
 * (`bun run native:build`).
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type * as Addon from "../../native/index";
import { VOCAB } from "./align";
import type { LyricLine } from "./align-stage";
import { beatTimes } from "./beats";
import { callsOf, goldenSongs, loadGolden, namedArray } from "./goldens";
import type { Grid } from "./grid";
import { gameRequest, type GameNote, type Note, type SyllableSpan, type TraceEntry } from "./notes";
import { makeChart, type ChartEngines } from "./pipeline";
import { midiFromHz, pitchTrack } from "./pitch-track";
import { applyEnds, applyPitchShifts, endFeatures, featureMatrix, noteFeatures, type PitchTrack } from "./refiners";

const LOADER = path.join(import.meta.dirname, "../../native/index.cjs");
const MODELS = process.env.TUNESTUDIO_CHART_MODELS;
/** GAME's ONNX folder (the PoC's models/game/pretrained-reexport-onnx: what its measured runs used). */
const GAME = process.env.TUNESTUDIO_CHART_GAME;
const built = fs.readdirSync(path.dirname(LOADER)).some((name) => name.endsWith(".node"));
const addon = built && goldenSongs().length ? (createRequire(LOADER)(LOADER) as typeof Addon) : null;
const model = (file: string) => path.join(MODELS!, file);

const untagged = <T extends object>(x: T & { $type?: string }): T => {
  const { $type: _, ...rest } = x;
  return rest as T;
};

/** Largest absolute difference, NaN only where both are NaN. */
function worst(a: ArrayLike<number>, b: ArrayLike<number>): number {
  expect(a.length).toBe(b.length);
  let most = 0;
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]!) || Number.isNaN(b[i]!)) expect([i, Number.isNaN(a[i]!)]).toEqual([i, Number.isNaN(b[i]!)]);
    else most = Math.max(most, Math.abs(a[i]! - b[i]!));
  }
  return most;
}

// Real models on whole songs: minutes, not the default 5 s.
/** The real addon with the exported models and GAME bound in. */
function realEngines(): ChartEngines {
  const a = addon!;
  return {
    trackPitch: (vocals) => a.trackPitch(model("fcpe-onnx/fcpe.onnx"), vocals),
    beatLogits: (mix) => a.beatLogits(model("beat-this-onnx/logmel.onnx"), model("beat-this-onnx/beat_this.onnx"), mix),
    alignerOutputs: (vocals, onProgress) =>
      a.alignerOutputs(
        model("tunestudio-aligner/aligner.onnx"),
        model("tunestudio-aligner/boundary.onnx"),
        vocals,
        onProgress,
      ),
    forcedAlign: (emissions, classes, from, to, targets) => a.forcedAlignPath(emissions, classes, from, to, targets),
    transcribeNotes: (vocals, requests, language, onProgress) =>
      a.transcribeNotes(GAME!, vocals, requests, language, onProgress),
    harmonicRatios: (vocals, notes) => a.harmonicRatios(vocals, notes),
    predictPitchShifts: (features) => a.predictPitchShifts(model("tunestudio-note-refiners/notefix.onnx"), features),
    predictNoteEnds: (features) => a.predictNoteEnds(model("tunestudio-note-refiners/ends.onnx"), features),
  };
}

describe.skipIf(!addon)("native chart functions against the PoC", { timeout: 600_000 }, () => {
  for (const song of goldenSongs()) {
    it(`aligns like ctc-forced-aligner: ${song}`, async () => {
      const golden = loadGolden(song);
      for (const call of callsOf(golden, "ctc_forced_aligner.get_alignments")) {
        const [emissions, tokens] = call.args as [Float32Array, string[]];
        const targets = Int32Array.from(
          tokens.flatMap((t) =>
            t === "<star>"
              ? [VOCAB["<star>"]!]
              : t
                  .split(" ")
                  .filter((c) => c in VOCAB)
                  .map((c) => VOCAB[c]!),
          ),
        );
        // The recorded emissions already have the "<star>" column: 32 classes.
        const frames = emissions.length / 32;
        const { path: got, scores } = await addon!.forcedAlignPath(emissions, 32, 0, frames, targets);
        const [segments, expectedScores] = call.result as [
          { label: string; start: number; end: number }[],
          Float32Array,
        ];
        const expected = Int32Array.from(
          segments.flatMap((s) => Array.from({ length: s.end - s.start + 1 }, () => VOCAB[s.label]!)),
        );
        expect(got).toEqual(expected);
        expect(scores).toEqual(expectedScores);
      }
    });

    it.skipIf(!MODELS)(`tracks pitch, loudness, emissions and syllable starts like the PoC: ${song}`, async () => {
      const vocals = namedArray(song, "audio.vocals16k");
      if (!vocals) return;
      const golden = loadGolden(song);
      const f0 = await addon!.trackPitch(model("fcpe-onnx/fcpe.onnx"), vocals);
      const track = pitchTrack(f0, vocals);
      expect(worst(track.midi, namedArray(song, "track.midi")!)).toBeLessThan(1e-3);
      expect(worst(track.rms, namedArray(song, "track.rms")!)).toBeLessThan(1e-3);
      expect(midiFromHz(Float32Array.of(440, 0))).toEqual(Float32Array.of(69, Number.NaN));

      const outputs = await addon!.alignerOutputs(
        model("tunestudio-aligner/aligner.onnx"),
        model("tunestudio-aligner/boundary.onnx"),
        vocals,
      );
      // The whole-song alignment got all the emissions (with the "<star>" column).
      const whole = callsOf(golden, "autotuner.align._align_tokens").find(
        (c) =>
          (c.kwargs as { offset: number }).offset === 0 && (c.args[0] as Float32Array).length / 32 === outputs.frames,
      );
      expect(whole).toBeDefined();
      const expected = whole!.args[0] as Float32Array;
      let most = 0;
      let argmaxSame = 0;
      for (let t = 0; t < outputs.frames; t++) {
        const row = outputs.emissions.subarray(t * 31, t * 31 + 31);
        const want = expected.subarray(t * 32, t * 32 + 31);
        for (let c = 0; c < 31; c++) if (want[c]! > -10) most = Math.max(most, Math.abs(row[c]! - want[c]!));
        if (row.indexOf(Math.max(...row)) === want.indexOf(Math.max(...want))) argmaxSame++;
      }
      expect(most).toBeLessThan(0.05);
      expect(argmaxSame / outputs.frames).toBeGreaterThan(0.999);
      const [assigned] = callsOf(golden, "autotuner.boundary.assign");
      expect(worst(outputs.syllableStarts, assigned!.args[1] as Float32Array)).toBeLessThan(1e-3);
    });

    it.skipIf(!MODELS)(`finds the beats like the PoC: ${song}`, async () => {
      const mix = namedArray(song, "audio.mix22k");
      if (!mix) return;
      const [fit] = callsOf(loadGolden(song), "Beats.fit_grid");
      const expected = fit!.args[0] as { beats: Float64Array; downbeats: Float64Array };
      const logits = await addon!.beatLogits(
        model("beat-this-onnx/logmel.onnx"),
        model("beat-this-onnx/beat_this.onnx"),
        mix,
      );
      expect(beatTimes(logits.beat, logits.downbeat)).toEqual({ beats: expected.beats, downbeats: expected.downbeats });
    });

    it.skipIf(!GAME)(`finds the notes like the PoC's GAME: ${song}`, async () => {
      const golden = loadGolden(song);
      const order = golden.calls.filter(
        (c) => c.fn === "autotuner.chart.notes_for_line_game" || c.fn === "Game.extract",
      );
      const lines: { spans: SyllableSpan[]; expected: GameNote[] }[] = [];
      let wav: Float32Array | null = null;
      let language = 0;
      order.forEach((call, i) => {
        if (call.fn !== "autotuner.chart.notes_for_line_game" || order[i + 1]?.fn !== "Game.extract") return;
        wav = call.args[1] as Float32Array;
        language = (call.kwargs as { language: number }).language;
        lines.push({
          spans: (call.args[0] as (SyllableSpan & { $type: string })[]).map(untagged),
          expected: (order[i + 1]!.result as (GameNote & { $type: string })[]).map(untagged),
        });
      });
      const requests = lines.map(({ spans }) => gameRequest(spans, wav!.length, 44_100)!);
      const notes = await addon!.transcribeNotes(
        GAME!,
        wav!,
        requests.map((r) => ({ from: r.from, to: r.to, known: r.known })),
        language,
      );
      let at = 0;
      let same = 0;
      let total = 0;
      lines.forEach(({ expected }, k) => {
        const count = notes.counts[k]!;
        const got = Array.from({ length: count }, (_, n): GameNote => ({
          start: notes.starts[at + n]!,
          end: notes.ends[at + n]!,
          voiced: notes.voiced[at + n] === 1,
          midi: notes.midi[at + n]!,
        }));
        at += count;
        total += expected.length;
        if (got.length !== expected.length) return;
        same += got.filter((g, n) => {
          const e = expected[n]!;
          return (
            g.voiced === e.voiced &&
            Math.abs(g.start - e.start) < 1e-6 &&
            Math.abs(g.end - e.end) < 1e-6 &&
            Math.abs(g.midi - e.midi) < 1e-3
          );
        }).length;
      });
      // GAME on another ONNX Runtime build: allow a few notes in a thousand to differ.
      expect(same / total).toBeGreaterThan(0.995);
    });

    it.skipIf(!MODELS || !GAME)(`makes the PoC's chart from the same vocals and lyrics: ${song}`, async () => {
      const golden = loadGolden(song);
      const vocals16k = namedArray(song, "audio.vocals16k");
      const mix22k = namedArray(song, "audio.mix22k");
      if (!vocals16k || !mix22k) return;
      const [stage] = callsOf(golden, "autotuner.pipeline._align_stage");
      const [, rawLines, languageName] = stage!.args as [string, (LyricLine & { alt_starts: number[] })[], string];
      const [line] = callsOf(golden, "autotuner.chart.notes_for_line_game");
      const lines = rawLines.map((l): LyricLine => ({
        text: l.text,
        start: l.start,
        end: l.end,
        altStarts: l.alt_starts,
      }));
      const name = languageName.toLowerCase();
      const result = await makeChart(
        {
          vocals16k,
          vocals44k: line!.args[1] as Float32Array,
          mix22k,
          lines,
          language: { name, code: name === "english" ? "eng" : "deu" },
        },
        realEngines(),
      );
      const [built] = callsOf(golden, "autotuner.chart.build_song");
      const expected = (built!.result as { voices: (Note & { $type: string })[][][] }).voices[0]!.map((l) =>
        l.map(untagged),
      );
      const got = result.lines;
      const flat = (ls: Note[][]) =>
        ls.flatMap((l) => l.map((n) => `${n.type} ${n.start} ${n.length} ${n.pitch} ${n.text}`));
      const [a, b] = [flat(got), flat(expected)];
      const same = a.filter((n, i) => n === b[i]).length;
      console.log(
        `${song}: ${same} of ${b.length} notes identical (${a.length} made), ${got.length} vs ${expected.length} lines`,
      );
      expect(same / b.length).toBeGreaterThan(0.99);
    });

    it(`measures harmonics like the PoC: ${song}`, async () => {
      const calls = callsOf(loadGolden(song), "autotuner.chart._harmonics");
      const wav = calls[0]!.args[0] as Float32Array;
      const ratios = await addon!.harmonicRatios(
        wav,
        calls.map((c) => {
          const [, , start, end, midi] = c.args as [unknown, number, number, number, number];
          return { start, end, midi };
        }),
      );
      calls.forEach((call, i) => {
        const expected = call.result as [number, number] | null;
        if (!expected) return expect([ratios[2 * i], ratios[2 * i + 1]]).toEqual([Number.NaN, Number.NaN]);
        expect(Math.abs(ratios[2 * i]! - expected[0])).toBeLessThan(1e-9);
        expect(Math.abs(ratios[2 * i + 1]! - expected[1])).toBeLessThan(1e-9);
      });
    });

    it.skipIf(!MODELS)(`corrects pitches and note ends like the PoC: ${song}`, async () => {
      const golden = loadGolden(song);
      for (const call of callsOf(golden, "autotuner.notefix.apply")) {
        const [notes, trace, track, tuning, scale] = call.args as [
          (Note & { $type: string })[],
          TraceEntry[],
          PitchTrack,
          number,
          number[] | null,
        ];
        const fixed = notes.map(untagged);
        const probabilities = await addon!.predictPitchShifts(
          model("tunestudio-note-refiners/notefix.onnx"),
          featureMatrix(noteFeatures(fixed, trace, track, tuning, scale)),
        );
        applyPitchShifts(fixed, probabilities);
        expect(fixed).toEqual((call.args_after![0] as (Note & { $type: string })[]).map(untagged));
      }
      for (const call of callsOf(golden, "autotuner.ends.apply")) {
        const [notes, trace, base, grid] = call.args as [
          (Note & { $type: string })[],
          TraceEntry[],
          number[][],
          Grid & { $type: string },
        ];
        const moved = notes.map(untagged);
        const deltas = await addon!.predictNoteEnds(
          model("tunestudio-note-refiners/ends.onnx"),
          featureMatrix(endFeatures(base, trace)),
        );
        applyEnds(moved, trace, deltas, untagged(grid), (call.args[5] as number | undefined) ?? 1);
        expect(moved).toEqual((call.args_after![0] as (Note & { $type: string })[]).map(untagged));
      }
    });
  }
});
