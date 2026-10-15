import { describe, expect, it } from "vitest";

import {
  autoPitchNotes,
  autoPitchNotesWithDiagnostics,
  DocumentValidationError,
  mergeNotes,
  parseUltraStar,
  serializeUltraStar,
  serializeUltraStarWithDiagnostics,
  splitNote,
  transposeNotes,
  validateDocument,
  type ChartDocument,
  type ChartLineBreak,
  type ChartNote,
} from "./index";

/** Lets a test pass deliberately malformed data where the API expects a typed value. */
const untyped = <T>(value: unknown): T => value as T;

const chart = () => parseUltraStar("#TITLE:Review\n#ARTIST:Original\n#BPM:120\n#GAP:0\n: 0 8 0 hello\nE\n").document;

function setNoteField(document: ChartDocument, key: keyof ChartNote, value: unknown): void {
  Object.assign(document.notes[0]!, { [key]: value });
}

describe("review: Unicode text survives validation/export/reimport", () => {
  for (const character of [" ", " "]) {
    for (const field of ["lyric", "TITLE"] as const) {
      it(`preserves U+${character.charCodeAt(0).toString(16)} in ${field}`, () => {
        const document = chart();
        const text = ` ${character}hello${character}world${character} `;
        if (field === "lyric") document.notes[0]!.lyric = text;
        else document.metadata.TITLE = text;
        expect(validateDocument(document)).toEqual([]);
        const exported = serializeUltraStarWithDiagnostics(document);
        expect(exported.warnings).toEqual([]);
        const imported = parseUltraStar(exported.text).document;
        expect(field === "lyric" ? imported.notes[0]!.lyric : imported.metadata.TITLE).toBe(text);
        expect(serializeUltraStar(imported)).toBe(exported.text);
      });
    }
  }
});

describe("review: weighted median is stable under confidence scaling", () => {
  it.each([1, 0.7, 0.3, 1e-12, 1e-13, 1e-100, Number.MIN_VALUE])(
    "takes the tied midpoint at confidence %s",
    (confidence) => {
      const note = chart().notes[0]!;
      const frames = [60, 60, 60, 72, 72, 72].map((midi, index) => ({ time: 0.1 + index * 0.1, midi, confidence }));
      expect(autoPitchNotes([note], frames, { minConfidence: 0 })[0]!.pitch).toBe(66);
    },
  );

  it.each([1, 0.7, 1e-12, 1e-13, 1e-100, 1e-300])(
    "does not invent a tie when unequal weights are scaled by %s",
    (scale) => {
      const note = chart().notes[0]!;
      const frames = [
        { time: 0.1, midi: 60, confidence: scale },
        { time: 0.2, midi: 72, confidence: scale * 0.1 },
      ];
      expect(autoPitchNotes([note], frames, { minConfidence: 0 })[0]!.pitch).toBe(60);
      expect(
        autoPitchNotes(
          [note],
          frames.map((frame) => ({ ...frame, midi: 132 - frame.midi })),
          { minConfidence: 0 },
        )[0]!.pitch,
      ).toBe(72);
    },
  );

  it("finds a mixed-weight tie with compensated sums, invariant to ordering and scale", () => {
    const note = chart().notes[0]!;
    for (const scale of [1, 0.7, 1e-12, 1e-100]) {
      const frames = [
        { time: 0.1, midi: 60, confidence: 0.1 * scale },
        { time: 0.2, midi: 60, confidence: 0.2 * scale },
        { time: 0.3, midi: 72, confidence: 0.3 * scale },
      ];
      expect(autoPitchNotes([note], frames, { minConfidence: 0 })[0]!.pitch).toBe(66);
      expect(autoPitchNotes([note], frames.toReversed(), { minConfidence: 0 })[0]!.pitch).toBe(66);
    }
  });

  it("does not erase a genuine near-tie weight difference", () => {
    const note = chart().notes[0]!;
    for (const scale of [1, 1e-12, 1e-100]) {
      expect(
        autoPitchNotes(
          [note],
          [
            { time: 0.1, midi: 60, confidence: scale },
            { time: 0.2, midi: 72, confidence: scale * (1 - 1e-10) },
          ],
          { minConfidence: 0 },
        )[0]!.pitch,
      ).toBe(60);
    }
  });
});

describe("review: imported half-open note boundaries", () => {
  it("excludes a 1.2s frame from the preceding BPM=150/GAP=1000 note", () => {
    const document = parseUltraStar(
      "#TITLE:Review\n#ARTIST:Original\n#BPM:150\n#GAP:1000\n: 1 1 0 before\n: 2 1 0 after\nE\n",
    ).document;
    const [before, after] = document.notes as [ChartNote, ChartNote];
    expect(before.start + before.duration).toBe(after.start);
    expect(after.start).toBe(1.2);
    const result = autoPitchNotesWithDiagnostics(document.notes, [{ time: 1.2, midi: 72, confidence: 0.9 }]);
    expect(result.notes.map((note) => note.pitch)).toEqual([60, 72]);
    expect(result.noEvidenceIds).toEqual([before.id]);
    expect(result.updatedIds).toEqual([after.id]);
  });

  it.each([120, 150, 217.5, 472.072, 123.456])(
    "keeps adjacent positive-audio boundaries identical at BPM %s",
    (bpm) => {
      const lines = Array.from({ length: 40 }, (_, index) => `: ${index + 1} 1 0 note${index}`);
      const document = parseUltraStar(
        `#TITLE:Review\n#ARTIST:Original\n#BPM:${bpm}\n#GAP:11251\n${lines.join("\n")}\nE\n`,
      ).document;
      for (let index = 1; index < document.notes.length; index++) {
        const before = document.notes[index - 1]!;
        const after = document.notes[index]!;
        expect(before.start + before.duration).toBe(after.start);
        const result = autoPitchNotes([before, after], [{ time: after.start, midi: 72, confidence: 0.9 }]);
        expect(result.map((note) => note.pitch)).toEqual([60, 72]);
      }
    },
  );

  it("retains real imported overlaps rather than assigning a frame to only one note", () => {
    const document = parseUltraStar(
      "#TITLE:Review\n#ARTIST:Original\n#BPM:150\n#GAP:1000\n: 1 2 0 before\n: 2 1 0 after\nE\n",
    ).document;
    expect(
      autoPitchNotes(document.notes, [{ time: 1.2, midi: 72, confidence: 0.9 }]).map((note) => note.pitch),
    ).toEqual([72, 72]);
  });

  it("retains even very small intentional editor overlaps without a broad time tolerance", () => {
    const note = chart().notes[0]!;
    const notes = [
      { ...note, start: 1.1, duration: 0.1000000001 },
      { ...note, id: "next", start: 1.2, duration: 0.1 },
    ];
    expect(autoPitchNotes(notes, [{ time: 1.2, midi: 72, confidence: 0.9 }]).map((item) => item.pitch)).toEqual([
      72, 72,
    ]);
  });
});

describe("review: malformed recovery JSON is diagnosed without coercion", () => {
  const invalidValues: unknown[] = [
    null,
    {},
    [],
    [1],
    ["normal"],
    { toString: null },
    { toString: [], valueOf: {} },
    [{ toString: null }],
  ];

  for (const field of ["id", "lineId", "start", "duration", "pitch", "lyric", "type", "player"] as const) {
    it.each(invalidValues.map((value) => [value]))(
      `validates malformed note ${field} = %j without throwing`,
      (value) => {
        const document = chart();
        setNoteField(document, field, JSON.parse(JSON.stringify(value)));
        const original = JSON.stringify(document);
        expect(() => validateDocument(document)).not.toThrow();
        const diagnostics = validateDocument(document);
        expect(diagnostics.some((item) => item.severity === "error")).toBe(true);
        expect(diagnostics.every((item) => !item.noteIds || item.noteIds.every((id) => typeof id === "string"))).toBe(
          true,
        );
        expect(() => serializeUltraStar(document)).toThrow(DocumentValidationError);
        expect(JSON.stringify(document)).toBe(original);
      },
    );
  }

  for (const field of ["lineId", "start", "end"] as const) {
    it.each(invalidValues.map((value) => [value]))(
      `validates malformed display break ${field} = %j without throwing`,
      (value) => {
        const document = chart();
        document.lineBreaks = [
          untyped<ChartLineBreak>({ lineId: document.notes[0]!.lineId, start: 1, end: 2, [field]: value }),
        ];
        expect(() => validateDocument(document)).not.toThrow();
        expect(validateDocument(document).some((item) => item.severity === "error")).toBe(true);
      },
    );
  }

  it("does not interpolate an invalid player or ID during overlap/line aggregation", () => {
    const document = chart();
    document.notes.push({ ...document.notes[0]!, id: "next" });
    const hostile = JSON.parse('{"toString":null,"valueOf":null}');
    setNoteField(document, "id", hostile);
    setNoteField(document, "player", hostile);
    setNoteField(document, "lineId", hostile);
    expect(() => validateDocument(document)).not.toThrow();
    expect(validateDocument(document).filter((item) => item.severity === "error")).toHaveLength(3);
  });

  it.each(["id", "version", "metadata", "notes", "lineBreaks"])("diagnoses malformed document field %s", (field) => {
    const document = chart();
    Object.assign(document, { [field]: JSON.parse('{"toString":null}') });
    expect(() => validateDocument(document)).not.toThrow();
    expect(validateDocument(document).some((item) => item.severity === "error")).toBe(true);
  });

  it.each(["BPM", "GAP", "RELATIVE", "TITLE", "ARTIST"])("diagnoses malformed metadata field %s", (field) => {
    const document = chart();
    document.metadata[field] = JSON.parse('{"toString":null}');
    expect(() => validateDocument(document)).not.toThrow();
    expect(validateDocument(document).some((item) => item.severity === "error")).toBe(true);
  });
});

describe("review: note types are strings, not coerced property keys", () => {
  it.each([["normal"], ["golden"], ["rap"], { toString: null }].map((type) => [type]))(
    "rejects type %j in validation, export, and editing",
    (type) => {
      const document = chart();
      setNoteField(document, "type", type);
      const note = document.notes[0]!;
      expect(
        validateDocument(document).some((item) => item.severity === "error" && item.message.includes("note type")),
      ).toBe(true);
      expect(() => serializeUltraStarWithDiagnostics(document)).toThrow(DocumentValidationError);
      expect(() => splitNote(note, 0.5)).toThrow(/Unsupported note type/);
      expect(() => mergeNotes([note])).toThrow(/Unsupported note type/);
      expect(() => transposeNotes([note], 1)).toThrow(/Unsupported note type/);
    },
  );
});
