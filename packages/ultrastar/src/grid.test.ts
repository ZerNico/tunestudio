import { describe, expect, it } from "vitest";

import { defaultSwitch } from "./grid";

describe("defaultSwitch", () => {
  it("puts a break without a stored switch where YASS, Karedi and UltraStar Deluxe put it", () => {
    const step = 0.1;
    expect(defaultSwitch(2, 7, step)).toBe(4);
    expect(defaultSwitch(2, 5, step)).toBe(3);
    expect(defaultSwitch(2, 2.1, step)).toBe(2);
    expect(defaultSwitch(2, 2.6, step)).toBeCloseTo(2.4);
    expect(defaultSwitch(2, 3.2, step)).toBeCloseTo(2.9);
    expect(defaultSwitch(2, 3.6, step)).toBeCloseTo(3.2);
    expect(defaultSwitch(2, 3.8, step)).toBeCloseTo(3);
  });
});
