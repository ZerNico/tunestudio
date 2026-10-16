import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { lyricLines, rangeProblem } from "./chart-range";
import { ChartRangeInput } from "./native/contract";

describe("chart range input", () => {
  it.each([
    { name: "a whole song", end: 300, lines: ["Hello world"] },
    { name: "a long lyric line", end: 300, lines: ["hello ".repeat(801).trim()] },
    { name: "many lyric lines", end: 600, lines: Array<string>(201).fill("Hello world again and again") },
  ])("accepts $name without arbitrary size limits", ({ end, lines }) => {
    const input = { id: "project", singerId: 1, start: 0, end, lines, language: "en" };
    expect(Schema.decodeUnknownSync(ChartRangeInput)(input)).toEqual(input);
    expect(rangeProblem(input, lines)).toBeNull();
  });

  it.each([
    { start: -1, end: 5 },
    { start: 5, end: 5 },
    { start: 5, end: 4 },
    { start: NaN, end: 5 },
    { start: 0, end: Infinity },
  ])("still rejects invalid time bounds: $start to $end", (range) => {
    expect(rangeProblem(range, ["Hello"])).toBe("Select a time range first.");
  });

  it("still requires singable lyrics and ignores empty rows", () => {
    const range = { start: 0, end: 300 };
    expect(rangeProblem(range, [])).toBe("Enter the lyrics sung in this range.");
    expect(rangeProblem(range, ["Hello", "---"])).toBe("Each line needs words to sing.");
    expect(lyricLines(" Hello \r\n\n world ")).toEqual(["Hello", "world"]);
  });
});
