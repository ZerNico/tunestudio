import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlayback } from "~/lib/editor/playback";

import { Transport } from "./transport";

class FakeAudio {
  currentTime = 0;
  duration = 100;
  preload = "";
  constructor(public src: string) {}
  play = () => Promise.resolve();
  pause() {}
  addEventListener() {}
  removeAttribute() {}
  load() {}
}

beforeEach(() => {
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("Transport", () => {
  it("switches between the song, its vocals and its music", async () => {
    const user = userEvent.setup();
    render(() => {
      const playback = createPlayback({ audio: "a", vocals: "v", instrumental: "i" });
      return <Transport playback={playback} length={100} onZoom={() => {}} />;
    });
    expect(screen.getByRole("button", { name: "Song" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Vocals" }));
    expect(screen.getByRole("button", { name: "Vocals" })).toHaveAttribute("aria-pressed", "true");
  });
});
