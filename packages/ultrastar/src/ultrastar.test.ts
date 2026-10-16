import { describe, expect, it } from "vitest";

import {
  createEmptyDocument,
  parseUltraStar,
  serializeUltraStar,
  serializeUltraStarWithDiagnostics,
  UltraStarError,
  DocumentValidationError,
  validateDocument,
  type ChartDocument,
} from "./index";

/** Lets a test pass deliberately malformed data where the API expects a typed value. */
const untyped = <T>(value: unknown): T => value as T;

const headers = "#TITLE:Night signals\n#ARTIST:Original fixture\n#BPM:120\n#GAP:1000\n";
const parse = (body: string) => parseUltraStar(headers + body).document;
const note = (body = ": 0 4 0 la \nE") => parse(body).notes[0]!;

function semantic(document: ChartDocument) {
  const lines = [...new Set(document.notes.map((item) => item.lineId))];
  return {
    metadata: document.metadata,
    notes: document.notes.map(({ id: _id, lineId, ...rest }) => ({ ...rest, line: lines.indexOf(lineId) })),
    breaks: document.lineBreaks?.map(({ lineId, ...rest }) => ({ ...rest, line: lines.indexOf(lineId) })),
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

describe("UltraStar parsing", () => {
  it("uses quarter-beat file ticks, GAP in milliseconds, MIDI pitch +60", () => {
    const document = parse(": -4 4 -12 low \n: 0 8 0 middle \n* 8 2 12 high\nE");
    expect(document.notes.map((item) => [item.start, item.duration, item.pitch])).toEqual([
      [0.5, 0.5, 48],
      [1, 1, 60],
      [2, 0.25, 72],
    ]);
    expect(new Set(document.notes.map((item) => item.id)).size).toBe(3);
    expect(document.notes.every((item) => item.lineId === document.notes[0]!.lineId)).toBe(true);
  });

  it("accepts BOM, CRLF, decimal comma, lowercase headers and Unicode", () => {
    const text =
      "﻿#title:  Écho: 🌙  \r\n#artist:Original\r\n#bpm:123,45\r\n#gap:-250,5\r\n#X-CUSTOM:  keep: value  \r\n: -4 4 +3 Hé\u2014llo  \r\nE\r\n";
    const { document } = parseUltraStar(text);
    expect(document.metadata.TITLE).toBe("  Écho: 🌙  ");
    expect(document.metadata["X-CUSTOM"]).toBe("  keep: value  ");
    expect(document.notes[0]!.lyric).toBe("Hé\u2014llo  ");
    expect(document.notes[0]!.start).toBeCloseTo(-0.2505 - 60 / 123.45, 10);
    expect(semantic(parseUltraStar(serializeUltraStar(document)).document)).toEqual(semantic(document));
  });

  it.each([" ", "  ", "\t", " \t word  ", "hello  ", "~", "", "🪶 café", "#not a header", "E", "a:b"])(
    "retains exact lyric %j",
    (lyric) => {
      const document = parse(`: 0 4 0 ${lyric}\nE`);
      expect(document.notes[0]!.lyric).toBe(lyric);
      expect(parseUltraStar(serializeUltraStar(document)).document.notes[0]!.lyric).toBe(lyric);
    },
  );

  it("accepts tabs between numeric fields without consuming lyric whitespace", () => {
    const document = parse(":\t0\t4\t0\t\t word \t\nE");
    expect(document.notes[0]!.lyric).toBe("\t word \t");
  });

  it("accepts empty lyrics and old Mac line endings", () => {
    expect(parseUltraStar((headers + ": 0 4 0\nE").replaceAll("\n", "\r")).document.notes[0]!.lyric).toBe("");
  });

  it("maps and roundtrips all five note types", () => {
    const document = parse(": 0 4 0 normal \n* 4 4 1 gold \nF 8 4 -9 speech \nR 12 4 0 rap \nG 16 4 3 golden rap\nE");
    expect(document.notes.map((item) => item.type)).toEqual(["normal", "golden", "freestyle", "rap", "golden-rap"]);
    expect(semantic(parseUltraStar(serializeUltraStar(document)).document)).toEqual(semantic(document));
  });

  it("retains ordinary, double-time and trailing display breaks", () => {
    const text = headers + ": 0 4 0 first\n- 5 7\n: 8 4 3 next\n- 16\nE\n";
    const document = parseUltraStar(text).document;
    expect(document.lineBreaks).toHaveLength(2);
    expect(document.notes[0]!.lineId).not.toBe(document.notes[1]!.lineId);
    expect(serializeUltraStar(document)).toBe(text);
  });

  it("warns when unrepresentable empty display lines are omitted", () => {
    const result = parseUltraStar(headers + "- 0\n: 4 2 1 a\n- 6\n- 7\nE");
    expect(result.warnings.filter((warning) => warning.includes("empty line"))).toHaveLength(2);
    expect(result.document.lineBreaks).toHaveLength(1);
  });

  it("supports two tracks, independent line membership, and interleaved switches", () => {
    const document = parse(
      "P1\n: 0 4 0 first \nP2\n: 0 4 7 second \n- 5\n: 8 4 7 voice\nP 1\n: 4 4 0 voice\n- 8\n: 12 4 0 again\nE",
    );
    expect(document.notes.map((item) => item.player)).toEqual([1, 2, 2, 1, 1]);
    expect(document.notes[0]!.lineId).toBe(document.notes[3]!.lineId);
    const output = serializeUltraStar(document);
    expect(output).toContain("P1\n");
    expect(output).toContain("P2\n");
    const imported = parseUltraStar(output).document;
    expect(imported.notes.filter((item) => item.player === 1).map((item) => item.lyric)).toEqual([
      "first ",
      "voice",
      "again",
    ]);
    expect(imported.notes.filter((item) => item.player === 2)).toHaveLength(2);
  });

  it("warns and assigns implicit notes to player 1 in mixed files", () => {
    const result = parseUltraStar(headers + ": 0 4 0 one\nP2\n: 0 4 7 two\nE");
    expect(result.document.notes.map((item) => item.player)).toEqual([1, 2]);
    expect(result.warnings.join(" ")).toContain("assigned to player 1");
  });

  it.each(["P3", "P0", "P4", "P1 2", "P1:", "Pboth"])("rejects ambiguous/unsupported track %s", (marker) => {
    expect(() => parse(`${marker}\n: 0 4 0 a\nE`)).toThrow(/P1 and P2/);
  });

  it.each(["YES", "yes", "1", "TRUE", "maybe", ""])("rejects relative mode %j", (mode) => {
    expect(() => parseUltraStar(headers + `#RELATIVE:${mode}\n: 0 4 0 a\nE`)).toThrow(/relative timing/);
  });

  it.each(["NO", "false", "0"])("retains explicit absolute mode %s", (mode) => {
    const result = parseUltraStar(headers + `#RELATIVE:${mode}\n: 0 4 0 a\nE`);
    expect(result.document.metadata.RELATIVE).toBe(mode);
  });

  it.each([
    [": 0 0 0 zero", /has no length/],
    [": 0 -2 0 negative", /has no length/],
    [": 0 1.5 0 fraction", /malformed/],
    [": 0 1 0.5 fractional pitch", /malformed/],
    [": 0 1 NaN bad", /malformed/],
    [": 0 1 0missing", /malformed/],
    [": 9007199254740992 1 0 huge", /safe integer/],
    ["- 5 4", /ends before it starts/],
    ["- 1 2 3", /line break isn't written/],
    ["B 0 120", /Unsupported/],
    ["S 0 4 0 sleep", /Unsupported/],
    ["#BPM", /header isn't written/],
    ["#BAD KEY:x", /Invalid header/],
    [": 0 4 0 bad\u0000", /isn't a text file/],
  ])("rejects invalid input %j with a useful error", (body, message) => {
    expect(() => parse(`${body}\nE`)).toThrow(message);
  });

  it("reports source line on malformed input", () => {
    try {
      parse(": 0 0 0 x\nE");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(UltraStarError);
      expect((error as UltraStarError).line).toBe(5);
    }
  });

  it.each(["", "0", "-12", "NaN", "Infinity", "120garbage", "1,2,3", "1e2"])("rejects invalid BPM %j", (bpm) => {
    expect(() => parseUltraStar(`#BPM:${bpm}\n: 0 4 0 a\nE`)).toThrow(/BPM/);
  });

  it("preserves decoded lyrics while normalizing an old encoding declaration for UTF-8 save", () => {
    const result = parseUltraStar(headers + "#ENCODING:CP1252\n: 0 4 0 éclair\nE");
    const exported = serializeUltraStarWithDiagnostics(result.document);
    expect(exported.text).toContain("#ENCODING:UTF8");
    expect(exported.text).toContain("éclair");
    expect(exported.warnings.join(" ")).toContain("UTF-8");
    expect(result.document.metadata.ENCODING).toBe("CP1252");
  });

  it("warns about likely decoding damage and omitted empty tracks", () => {
    const result = parseUltraStar(headers + "P1\nP2\n: 0 4 0 caf�\nE");
    expect(result.warnings.join(" ")).toContain("characters are damaged");
    expect(result.warnings.join(" ")).toContain("Singer 1 has no notes");
  });

  it("retains duet singer names and arbitrary header punctuation in values", () => {
    const extra = "#DUETSINGERP1:Low voice\n#DUETSINGERP2:High voice\n#VIDEO:v=xyz,co=https://example.test/a:b?c=d\n";
    const document = parseUltraStar(headers + extra + "P1\n: 0 4 0 a\nP2\n: 0 4 7 b\nE").document;
    expect(serializeUltraStar(document)).toContain(extra);
  });

  it("requires BPM, but GAP defaults to zero with a diagnostic", () => {
    expect(() => parseUltraStar("#TITLE:No grid\nE")).toThrow(/BPM/);
    const result = parseUltraStar("#BPM:120\n: 0 4 0 a\nE");
    expect(result.document.notes[0]!.start).toBe(0);
    expect(result.warnings.join(" ")).toContain("no #GAP");
  });

  it("rejects conflicting duplicates, warns for exact duplicate headers", () => {
    expect(() => parseUltraStar(headers + "#BPM:121\nE")).toThrow(/there twice/);
    expect(parseUltraStar(headers + "#BPM:120\nE").warnings.join(" ")).toContain("duplicate #BPM");
  });

  it("rejects headers in the body and nonempty content after E", () => {
    expect(() => parse(": 0 4 0 a\n#TITLE:new\nE")).toThrow(/Headers must precede/);
    expect(() => parse("E\nP2\n: 0 4 0 a")).toThrow(/after the end marker/);
  });

  it("warns for missing E and chronological sorting", () => {
    const result = parseUltraStar(headers + ": 8 2 0 late\n: 0 2 0 early");
    expect(result.warnings.join(" ")).toContain("end marker (E) is missing");
    expect(result.warnings.join(" ")).toContain("out of order");
    expect(parseUltraStar(serializeUltraStar(result.document)).document.notes[0]!.lyric).toBe("early");
  });
});

describe("serialization and validation", () => {
  it("does not mutate frozen input, preserves headers, emits LF and E", () => {
    const document = freeze(parse(": 0 4 0 a\n- 4\n: 8 4 3 b\nE"));
    const before = JSON.stringify(document);
    const text = serializeUltraStar(document);
    expect(text).toMatch(/E\n$/);
    expect(text).not.toContain("\r");
    expect(JSON.stringify(document)).toBe(before);
  });

  it("rounds both edges, gives tiny notes one tick, and diagnoses lossy export", () => {
    const document = parse(": 0 4 0 a\nE");
    document.notes[0] = { ...document.notes[0]!, start: 1.03, duration: 0.01 };
    const result = serializeUltraStarWithDiagnostics(document);
    expect(result.text).toContain(": 0 1 0 a");
    expect(result.warnings.join(" ")).toContain("beat grid");
    expect(document.notes[0]!.start).toBe(1.03);
    expect(document.notes[0]!.duration).toBe(0.01);
  });

  it("adds breaks for newly created lyric lines", () => {
    const document = parse(": 0 4 0 one\n: 8 4 0 two\nE");
    document.notes[1]!.lineId = "new-line";
    expect(serializeUltraStar(document)).toContain("one\n- 6\n: 8");
  });

  it("writes a break without a stored switch where the editor draws it", () => {
    // A tick is 1/8 s: gaps of 1 tick (at the end), 4 (two before the next note) and 20, 2.5 s (1 s after the end).
    const document = parse(": 0 4 0 a\n: 5 2 0 b\n: 11 2 0 c\n: 33 2 0 d\nE");
    for (const [index, note] of document.notes.entries()) note.lineId = `line-${index}`;
    expect(serializeUltraStar(document)).toContain("a\n- 4\n: 5 2 0 b\n- 9\n: 11 2 0 c\n- 21\n");
  });

  it("warns about stale break timing instead of silently rewriting it", () => {
    const document = parse(": 0 4 0 one\n- 4\n: 8 4 0 two\nE");
    document.notes[0]!.duration = 0.75;
    const result = serializeUltraStarWithDiagnostics(document);
    expect(result.warnings.join(" ")).toContain("inside a line");
    expect(result.text).toContain("- 4\n");
  });

  it("rejects interleaved lyric lines that cannot survive TXT serialization", () => {
    const document = parse(": 0 4 0 one\n: 8 4 0 two\n: 16 4 0 three\nE");
    document.notes[1]!.lineId = "middle";
    expect(() => serializeUltraStar(document)).toThrow(/interleaved/);
  });

  it("retains extreme but integer pitches without clamping", () => {
    const document = parse(": 0 4 -70 unusual\nE");
    expect(document.notes[0]!.pitch).toBe(-10);
    expect(validateDocument(document).some((item) => item.message.includes("unusually high or low"))).toBe(true);
    expect(serializeUltraStar(document)).toContain(": 0 4 -70 unusual");
  });

  it("warns about overlap in one track but not across singers", () => {
    const overlap = parse(": 0 8 0 a\n: 4 8 0 b\nE");
    expect(validateDocument(overlap).some((item) => item.message.includes("overlapping"))).toBe(true);
    const duet = parse("P1\n: 0 8 0 a\nP2\n: 4 8 0 b\nE");
    expect(validateDocument(duet).some((item) => item.message.includes("overlapping"))).toBe(false);
  });

  it.each([
    { start: NaN },
    { duration: 0 },
    { duration: Infinity },
    { duration: -1 },
    { pitch: 60.4 },
    { pitch: NaN },
    { lyric: "line\nbreak" },
    { lyric: "a\rb" },
    { type: "invalid" },
    { id: "" },
    { lineId: "" },
    { player: 3 },
    { start: 1e100 },
  ])("rejects malformed note fields %j", (override) => {
    const document = createEmptyDocument();
    document.notes = [{ ...note(), ...override } as ChartDocument["notes"][number]];
    expect(validateDocument(document).some((item) => item.severity === "error")).toBe(true);
    expect(() => serializeUltraStar(document)).toThrow(DocumentValidationError);
  });

  it("detects duplicate IDs, cross-player lines and metadata injection", () => {
    const document = parse(": 0 4 0 a\n: 8 4 0 b\nE");
    document.notes[1]!.id = document.notes[0]!.id;
    document.notes[1]!.player = 2;
    document.metadata.TITLE = "title\n: 0 4 0 injected";
    const errors = validateDocument(document)
      .map((item) => item.message)
      .join(" ");
    expect(errors).toContain("duplicate note ID");
    expect(errors).toContain("different player");
    expect(errors).toContain("single-line");
  });

  it.each([null, undefined, {}, { version: 99, notes: null }, { metadata: [], notes: [null, false] }])(
    "validates corrupt recovery data %j without crashing",
    (value) => {
      expect(validateDocument(untyped<ChartDocument>(value)).some((item) => item.severity === "error")).toBe(true);
    },
  );

  it("validates stale, orphaned, invalid and duplicate line-break entries", () => {
    const document = parse(": 0 4 0 a\n- 4\n: 8 4 0 b\nE");
    document.lineBreaks![0]!.start = 0;
    expect(validateDocument(document).some((item) => item.message.includes("inside a line"))).toBe(true);
    document.lineBreaks!.push({ lineId: "deleted", start: 4 });
    expect(serializeUltraStarWithDiagnostics(document).warnings.join(" ")).toContain("has no line");
    document.lineBreaks!.push({ ...document.lineBreaks![0]! });
    expect(() => serializeUltraStar(document)).toThrow(/Duplicate display break/);
    document.lineBreaks = [{ lineId: document.notes[0]!.lineId, start: 2, end: 1 }];
    expect(() => serializeUltraStar(document)).toThrow(/invalid times/);
    document.lineBreaks = [{ lineId: document.notes[0]!.lineId, start: 1e30 }];
    expect(() => serializeUltraStar(document)).toThrow(/too far into the song/);
  });

  it("diagnoses display-break rounding independently of note rounding", () => {
    const document = parse(": 0 4 0 a\n- 4\n: 8 4 0 b\nE");
    document.lineBreaks![0]!.start = 1.51;
    const result = serializeUltraStarWithDiagnostics(document);
    expect(result.warnings.join(" ")).toContain("line break after line");
    expect(result.warnings.join(" ")).toContain("beat grid");
    expect(result.text).toContain("- 4");
  });

  it.each([
    { BPM: "0" },
    { GAP: "oops" },
    { RELATIVE: "YES" },
    { TITLE: "bad\rtitle" },
    { TITLE: "bad\u0000title" },
    { title: "lowercase key" },
    { "BAD:KEY": "bad" },
    { BPM: null },
  ])("blocks invalid editor metadata %j", (metadata) => {
    const document = createEmptyDocument();
    Object.assign(document.metadata, metadata);
    expect(() => serializeUltraStar(document)).toThrow(DocumentValidationError);
  });

  it("generates fresh document/line/note IDs per import", () => {
    const first = parse(": 0 4 0 a\nE");
    const second = parse(": 0 4 0 a\nE");
    expect(first.id).not.toBe(second.id);
    expect(first.notes[0]!.id).not.toBe(second.notes[0]!.id);
    expect(first.notes[0]!.lineId).not.toBe(second.notes[0]!.lineId);
  });

  it("roundtrips an empty document", () => {
    const empty = createEmptyDocument();
    expect(parseUltraStar(serializeUltraStar(empty)).document.notes).toEqual([]);
  });

  it("survives randomized fractional BPM/GAP and negative tick roundtrips", () => {
    let state = 47207;
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    for (let trial = 0; trial < 100; trial++) {
      const bpm = (60 + random() * 700).toFixed(6);
      const gap = (random() * 20000 - 1000).toFixed(3);
      let tick = -100;
      const lines = [`#TITLE:Generated ${trial}`, "#ARTIST:Original test", `#BPM:${bpm}`, `#GAP:${gap}`];
      for (let index = 0; index < 25; index++) {
        const length = Math.floor(random() * 30) + 1;
        lines.push(`: ${tick} ${length} ${Math.floor(random() * 48) - 24} word ${index} `);
        tick += length + Math.floor(random() * 10);
        if (index % 5 === 4) lines.push(`- ${tick}`);
      }
      lines.push("E");
      const text = lines.join("\n") + "\n";
      const result = serializeUltraStar(parseUltraStar(text).document);
      expect(result).toBe(text);
    }
  });
});
