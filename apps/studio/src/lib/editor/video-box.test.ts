import { describe, expect, it } from "vitest";

import { clampBox, FIRST_BOX, movedBox, resizedBox } from "./video-box";

const AREA = { width: 1000, height: 600 };

describe("the video preview's box", () => {
  it("moves with the pointer and stays inside the area", () => {
    expect(movedBox(FIRST_BOX, -100, 50, AREA)).toEqual({ top: 102, right: 112, width: 240 });
    expect(movedBox(FIRST_BOX, 500, -500, AREA)).toEqual({ top: 0, right: 0, width: 240 });
    expect(movedBox(FIRST_BOX, -5000, 5000, AREA)).toEqual({ top: 465, right: 760, width: 240 });
  });

  it("grows to the left from its bottom-left corner, as far as the area allows", () => {
    expect(resizedBox(FIRST_BOX, -160, AREA)).toEqual({ top: 52, right: 12, width: 400 });
    expect(resizedBox(FIRST_BOX, 500, AREA).width).toBe(160);
    // As wide as the room below it allows (548 px high: 974 px wide).
    expect(resizedBox(FIRST_BOX, -5000, AREA).width).toBeCloseTo(974.2, 1);
  });

  it("comes back inside when the area shrinks", () => {
    expect(clampBox({ top: 500, right: 900, width: 400 }, { width: 600, height: 400 })).toEqual({
      top: 175,
      right: 200,
      width: 400,
    });
  });
});
