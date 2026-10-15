import { describe, expect, it } from "vitest";

import { decodeChart } from "./decode";

const bytes = (text: string) => new TextEncoder().encode(text);
const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
function utf16(text: string, bigEndian: boolean) {
  const result = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    result[index * 2 + (bigEndian ? 1 : 0)] = code & 0xff;
    result[index * 2 + (bigEndian ? 0 : 1)] = code >> 8;
  }
  return result;
}

describe("decodeChart", () => {
  it("reads UTF-8, UTF-16 with a BOM, and undeclared Windows-1252", () => {
    expect(decodeChart(bytes("#TITLE:Grüße"))).toBe("#TITLE:Grüße");
    expect(decodeChart(Uint8Array.of(0xff, 0xfe, 65, 0, 66, 0))).toBe("AB");
    expect(decodeChart(Uint8Array.of(0xfe, 0xff, 0, 65, 0, 66))).toBe("AB");
    expect(decodeChart(Uint8Array.of(0xfc))).toBe("ü");
    expect(decodeChart(latin1("#TITLE:Caf\xe9 \x80"))).toBe("#TITLE:Café €");
  });

  it.each(["CP1251", "windows-1251", "cp-1251"])("decodes a chart declared as %s", (label) => {
    const cyrillic = Uint8Array.of(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2);
    const chart = concat(
      bytes(`  # encoding : ${label}\r#TITLE:`),
      cyrillic,
      bytes("\r: 0 4 0 "),
      cyrillic,
      bytes("\rE\r"),
    );
    expect(decodeChart(chart)).toContain("#TITLE:Привет");
    expect(decodeChart(chart)).toContain(": 0 4 0 Привет");
  });

  it("decodes declared CP1252 and UTF8 charts", () => {
    expect(decodeChart(latin1("#ENCODING:CP1252\n#TITLE:Gr\xfc\xdfe"))).toBe("#ENCODING:CP1252\n#TITLE:Grüße");
    expect(decodeChart(bytes("#ENCODING:UTF8\n#TITLE:Привет"))).toBe("#ENCODING:UTF8\n#TITLE:Привет");
    expect(decodeChart(bytes(" #ENCODING:UTF8\n#TITLE:Grüße"))).toBe(" #ENCODING:UTF8\n#TITLE:Grüße");
  });

  describe.each(["utf-8", "utf-16le", "utf-16be"])("with a %s BOM", (encoding) => {
    const encode = (text: string) =>
      encoding === "utf-8"
        ? concat(Uint8Array.of(0xef, 0xbb, 0xbf), bytes(text))
        : encoding === "utf-16le"
          ? concat(Uint8Array.of(0xff, 0xfe), utf16(text, false))
          : concat(Uint8Array.of(0xfe, 0xff), utf16(text, true));

    it.each([encoding, encoding === "utf-8" ? "UTF8" : "UTF16"])("accepts a matching %s declaration", (label) => {
      const text = `#ENCODING:${label}\n#TITLE:Привет\nE\n`;
      expect(decodeChart(encode(text))).toBe(text);
    });

    it("rejects a declaration that contradicts the BOM", () => {
      expect(() => decodeChart(encode("#ENCODING:CP1251\nE\n"))).toThrow(/byte order mark/);
    });

    it("rejects bytes that aren't valid in the BOM's encoding", () => {
      const prefix = encode("");
      const invalid = concat(prefix, encoding === "utf-8" ? Uint8Array.of(0xff) : Uint8Array.of(0x00));
      expect(() => decodeChart(invalid)).toThrow(/valid/);
    });
  });

  it.each(["#ENCODING:unknown-encoding\nE", "#ENCODING:\nE"])("rejects the unsupported declaration %j", (text) => {
    expect(() => decodeChart(bytes(text))).toThrow(expect.objectContaining({ code: "UNSUPPORTED_ENCODING" }));
  });

  it("rejects conflicting declarations, invalid declared UTF-8 and UTF-16 without a BOM", () => {
    expect(() => decodeChart(bytes("#ENCODING:CP1251\n#encoding:UTF8\nE"))).toThrow(/two different encodings/);
    expect(() => decodeChart(latin1("#ENCODING:UTF8\n#TITLE:\xff"))).toThrow(/valid UTF-8/);
    expect(() => decodeChart(bytes("#ENCODING:UTF16\nE"))).toThrow(/byte order mark/);
  });
});
