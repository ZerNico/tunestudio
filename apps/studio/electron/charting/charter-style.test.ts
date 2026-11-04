import { describe, expect, it } from "vitest";

import { keepNotesApart } from "./charter-style";
import type { Note } from "./notes";

const n = (start: number, length: number, text: string): Note => ({ type: "normal", start, length, pitch: 0, text });

describe("keepNotesApart", () => {
  it("leaves a beat between notes, as usdb_syncer would", () => {
    const lines = [[n(1160, 4, "mit"), n(1164, 6, "~ ")], [n(1170, 4, "uns ")]];
    keepNotesApart(lines);
    expect(lines.flat().map((note) => note.length)).toEqual([3, 5, 4]);
  });

  it("keeps a one-beat note", () => {
    const lines = [[n(10, 1, "a"), n(11, 2, "b ")]];
    keepNotesApart(lines);
    expect(lines[0]!.map((note) => note.length)).toEqual([1, 2]);
  });
});
