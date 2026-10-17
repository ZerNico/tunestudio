import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HINT_DELAY_MS, keyHintsShown, listenForKeyHints } from "./key-hints";

const press = (type: "keydown" | "keyup", key: string, init: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent(type, { key, ...init }));

describe("key hints", () => {
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    stop = listenForKeyHints(window, "Meta");
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("show while the modifier is held on its own, and go when it is let go", () => {
    press("keydown", "Meta");
    vi.advanceTimersByTime(HINT_DELAY_MS - 1);
    flush();
    expect(keyHintsShown()).toBe(false);
    vi.advanceTimersByTime(1);
    flush();
    expect(keyHintsShown()).toBe(true);
    press("keyup", "Meta");
    flush();
    expect(keyHintsShown()).toBe(false);
  });

  it("don't show while typing in a field", () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    press("keydown", "Meta");
    vi.advanceTimersByTime(HINT_DELAY_MS);
    flush();
    expect(keyHintsShown()).toBe(false);
    field.remove();
  });

  it("don't show for a shortcut, a click or a scroll with the modifier", () => {
    press("keydown", "Meta");
    press("keydown", "z", { metaKey: true });
    vi.advanceTimersByTime(HINT_DELAY_MS);
    flush();
    expect(keyHintsShown()).toBe(false);
    press("keydown", "Meta");
    window.dispatchEvent(new Event("wheel"));
    vi.advanceTimersByTime(HINT_DELAY_MS);
    flush();
    expect(keyHintsShown()).toBe(false);
  });
});
