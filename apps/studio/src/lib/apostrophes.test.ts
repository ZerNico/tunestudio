import { describe, expect, it } from "vitest";

import { fixApostrophes } from "./apostrophes";

describe("fixApostrophes", () => {
  it("writes the typographer's apostrophe for its look-alikes", () => {
    expect(fixApostrophes("Konnt´ ")).toBe("Konnt’ ");
    expect(fixApostrophes("´n")).toBe("’n");
    expect(fixApostrophes("‘nem")).toBe("’nem");
    expect(fixApostrophes("don't `cause ′til")).toBe("don’t ’cause ’til");
  });

  it("makes two typewriter apostrophes a double quote", () => {
    expect(fixApostrophes("''Hey''")).toBe('"Hey"');
  });

  it("leaves the right ones alone", () => {
    expect(fixApostrophes("Wünscht’ ich, „sagt“ er")).toBe("Wünscht’ ich, „sagt“ er");
  });
});
