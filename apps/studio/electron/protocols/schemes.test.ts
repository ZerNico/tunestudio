import { describe, expect, it, vi } from "vitest";

import { APP_ORIGIN, originOf } from "./schemes";

// `electron` only resolves inside the Electron runtime (vi.mock is hoisted above the import);
// originOf never touches it.
vi.mock("electron", () => ({ protocol: {} }));

describe("originOf", () => {
  it("gives app:// pages a real origin, unlike URL#origin", () => {
    expect(new URL(`${APP_ORIGIN}/index.html`).origin).toBe("null");
    expect(originOf(`${APP_ORIGIN}/index.html`)).toBe(APP_ORIGIN);
    expect(originOf(`${APP_ORIGIN}/assets/app.js?x=1#y`)).toBe(APP_ORIGIN);
  });

  it("keeps web origins as the URL parser has them", () => {
    expect(originOf("http://localhost:1430/")).toBe("http://localhost:1430");
    expect(originOf("https://www.youtube.com/watch?v=x")).toBe("https://www.youtube.com");
  });

  it("does not confuse the app with other hosts or unregistered schemes", () => {
    expect(originOf("app://evil/index.html")).toBe("app://evil");
    expect(originOf("app://evil/index.html")).not.toBe(APP_ORIGIN);
    expect(originOf("other://tunestudio/index.html")).toBeNull();
  });

  it("returns null for opaque and unparseable URLs", () => {
    expect(originOf("data:text/html,hi")).toBeNull();
    expect(originOf("about:blank")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });
});
