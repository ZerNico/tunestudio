import { describe, expect, it } from "vitest";

import { tagsOf, withTags } from "./tags";

describe("tags", () => {
  const headers: [string, string][] = [
    ["X-CUSTOM", "kept"],
    ["TAGS", "synthetic,  test ,"],
    ["X-OTHER", "too"],
  ];

  it("reads the tags from #TAGS", () => {
    expect(tagsOf(headers)).toEqual(["synthetic", "test"]);
    expect(tagsOf([])).toEqual([]);
  });

  it("writes them where #TAGS is, adds it at the end, and drops it when there are none", () => {
    expect(withTags(headers, ["live", "acoustic"])).toEqual([
      ["X-CUSTOM", "kept"],
      ["TAGS", "live, acoustic"],
      ["X-OTHER", "too"],
    ]);
    expect(withTags([["X-CUSTOM", "kept"]], ["live"])).toEqual([
      ["X-CUSTOM", "kept"],
      ["TAGS", "live"],
    ]);
    expect(withTags(headers, [" "])).toEqual([
      ["X-CUSTOM", "kept"],
      ["X-OTHER", "too"],
    ]);
  });
});
