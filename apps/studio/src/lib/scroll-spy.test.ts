import { describe, expect, it } from "vitest";

import { sectionReached } from "./scroll-spy";

describe("sectionReached", () => {
  const page = { clientHeight: 600, scrollHeight: 1800 };

  it("waits until the section's top passes the upper third", () => {
    expect(sectionReached({ ...page, scrollTop: 0, sectionTop: 700 })).toBe(false);
    expect(sectionReached({ ...page, scrollTop: 300, sectionTop: 201 })).toBe(false);
    expect(sectionReached({ ...page, scrollTop: 400, sectionTop: 200 })).toBe(true);
    expect(sectionReached({ ...page, scrollTop: 900, sectionTop: -300 })).toBe(true);
  });

  it("counts the bottom of a page too short to bring the section up", () => {
    expect(sectionReached({ ...page, scrollTop: 1200, sectionTop: 450 })).toBe(true);
    expect(sectionReached({ ...page, scrollTop: 1100, sectionTop: 450 })).toBe(false);
  });

  it("doesn't count a page that can't scroll as scrolled to the bottom", () => {
    expect(sectionReached({ clientHeight: 800, scrollHeight: 800, scrollTop: 0, sectionTop: 500 })).toBe(false);
  });
});
