import { describe, expect, it } from "vitest";

import { chartInputsKey } from "./chart-inputs";
import { languageCode } from "./languages";

describe("chartInputsKey", () => {
  const lines = [
    { start: 1, text: "Hello" },
    { start: 2, text: "there " },
  ];

  it("is the same for the same lyrics and language", () => {
    expect(chartInputsKey(lines, "en")).toBe(
      chartInputsKey(
        [
          { start: 1, text: "Hello" },
          { start: 2, text: "there" },
        ],
        "en",
      ),
    );
  });

  it("changes with the text, a line's time or the language", () => {
    const key = chartInputsKey(lines, "en");
    expect(chartInputsKey([{ start: 1, text: "Hallo" }, lines[1]!], "en")).not.toBe(key);
    expect(chartInputsKey([{ start: 1.5, text: "Hello" }, lines[1]!], "en")).not.toBe(key);
    expect(chartInputsKey(lines, "de")).not.toBe(key);
  });
});

describe("languageCode", () => {
  it("takes a tag's primary language", () => {
    expect([
      languageCode("en-US"),
      languageCode("DE"),
      languageCode(""),
      languageCode(null),
      languageCode("und-x"),
    ]).toEqual(["en", "de", null, null, "und"]);
  });
});
