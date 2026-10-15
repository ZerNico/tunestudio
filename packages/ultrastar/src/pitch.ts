import type { ChartNote, PitchFrame } from "./types";

export interface AutoPitchOptions {
  minConfidence?: number;
}
export interface AutoPitchResult {
  notes: ChartNote[];
  updatedIds: string[];
  /** Tonal notes without sufficient valid cached evidence. */
  noEvidenceIds: string[];
  /** Freestyle and rap do not carry a scored melody. */
  skippedIds: string[];
  ignoredFrameCount: number;
}

/**
 * Uses actual cached frames only. Times must already be absolute audio seconds.
 * Half-open note windows [start, end) prevent a boundary frame leaking into two notes.
 * Confidence-weighted MIDI median resists octave/outlier errors; no interpolation or fake inference.
 */
export function autoPitchNotesWithDiagnostics(
  notes: readonly ChartNote[],
  frames: readonly PitchFrame[],
  options: AutoPitchOptions = {},
): AutoPitchResult {
  if (!Array.isArray(notes) || !Array.isArray(frames))
    throw new TypeError("Auto pitch requires arrays of notes and pitch frames.");
  const minConfidence = options.minConfidence ?? 0.5;
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)
    throw new RangeError("minConfidence must be between 0 and 1.");
  const valid = frames
    .filter(
      (frame) =>
        frame &&
        Number.isFinite(frame.time) &&
        Number.isFinite(frame.midi) &&
        frame.midi >= 0 &&
        frame.midi <= 127 &&
        Number.isFinite(frame.confidence) &&
        frame.confidence > 0 &&
        frame.confidence >= minConfidence &&
        frame.confidence <= 1,
    )
    .toSorted((a, b) => a.time - b.time);
  const updatedIds: string[] = [];
  const noEvidenceIds: string[] = [];
  const skippedIds: string[] = [];
  function lowerBound(time: number): number {
    let lo = 0;
    let hi = valid.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (valid[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  const result = notes.map((note) => {
    if (
      !note ||
      !Number.isFinite(note.start) ||
      !Number.isFinite(note.duration) ||
      note.duration <= 0 ||
      !Number.isFinite(note.start + note.duration) ||
      note.start + note.duration === note.start
    ) {
      throw new RangeError(`Note ${note?.id ?? "(missing)"}: auto pitch requires finite timing and positive duration.`);
    }
    if (note.type !== "normal" && note.type !== "golden") {
      skippedIds.push(note.id);
      return note;
    }
    const first = lowerBound(note.start);
    const last = lowerBound(note.start + note.duration);
    const window = valid.slice(first, last).toSorted((a, b) => a.midi - b.midi);
    if (!window.length) {
      noEvidenceIds.push(note.id);
      return note;
    }
    // Normalize before summing so uniformly tiny positive confidences do not underflow.
    const maxWeight = window.reduce((max, frame) => Math.max(max, frame.confidence), 0);
    let totalWeight = 0;
    let compensation = 0;
    const cumulativeWeights = window.map((frame) => {
      const adjusted = frame.confidence / maxWeight - compensation;
      const next = totalWeight + adjusted;
      compensation = next - totalWeight - adjusted;
      totalWeight = next;
      return totalWeight;
    });
    const halfWeight = totalWeight / 2;
    const epsilon = totalWeight * Number.EPSILON * 4;
    let midi = window[window.length - 1].midi;
    for (let index = 0; index < window.length; index++) {
      const weight = cumulativeWeights[index]!;
      if (weight >= halfWeight - epsilon) {
        midi = window[index].midi;
        // Use the same total-relative tolerance for crossing and midpoint ties.
        if (Math.abs(weight - halfWeight) <= epsilon && index + 1 < window.length)
          midi = (midi + window[index + 1].midi) / 2;
        break;
      }
    }
    const pitch = Math.round(midi);
    if (pitch === note.pitch) return note;
    updatedIds.push(note.id);
    return { ...note, pitch };
  });
  return { notes: result, updatedIds, noEvidenceIds, skippedIds, ignoredFrameCount: frames.length - valid.length };
}

export function autoPitchNotes(notes: ChartNote[], frames: PitchFrame[], opts?: AutoPitchOptions): ChartNote[] {
  return autoPitchNotesWithDiagnostics(notes, frames, opts).notes;
}
