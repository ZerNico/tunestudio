import { describe, expect, it } from "vitest";

import {
  DocumentValidationError,
  parseUltraStar,
  serializeUltraStar,
  serializeUltraStarWithDiagnostics,
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
    "rejects type %j in validation and export",
    (type) => {
      const document = chart();
      setNoteField(document, "type", type);
      expect(
        validateDocument(document).some((item) => item.severity === "error" && item.message.includes("note type")),
      ).toBe(true);
      expect(() => serializeUltraStarWithDiagnostics(document)).toThrow(DocumentValidationError);
    },
  );
});
