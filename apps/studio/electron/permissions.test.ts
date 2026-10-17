import { describe, expect, it } from "vitest";

import { allowsPermission } from "./permissions";

const APP = "app://tunestudio";

describe("web permissions", () => {
  it("lets the app's pages write the clipboard and hear the microphone, and nothing else", () => {
    expect(allowsPermission(APP, APP, "clipboard-sanitized-write")).toBe(true);
    expect(allowsPermission(APP, APP, "media", ["audio"])).toBe(true);
    expect(allowsPermission(APP, APP, "media", ["audio", "video"])).toBe(false);
    expect(allowsPermission(APP, APP, "media")).toBe(false);
    expect(allowsPermission(APP, APP, "geolocation")).toBe(false);
    expect(allowsPermission("https://example.com", APP, "media", ["audio"])).toBe(false);
  });
});
