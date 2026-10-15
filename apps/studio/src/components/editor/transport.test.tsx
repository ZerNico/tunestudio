import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPlayback } from "~/lib/editor/playback";

import { Transport } from "./transport";

/** The props besides playback that each test doesn't care about. */
const rest = {
  length: 100,
  onZoom: () => {},
  onShowPitch: () => {},
  looping: false,
  onLoop: () => {},
  following: true,
  onFollow: () => {},
  tones: false,
  onTones: () => {},
};

class FakeAudio {
  currentTime = 0;
  duration = 100;
  playbackRate = 1;
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
  // Frames run (menus open on one); nothing plays, so playback asks for none.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => vi.unstubAllGlobals());

describe("Transport", () => {
  it("switches between the song, its vocals and its music", async () => {
    const user = userEvent.setup();
    render(() => {
      const playback = createPlayback({ audio: "a", vocals: "v", instrumental: "i" });
      return <Transport playback={playback} {...rest} />;
    });
    expect(screen.getByRole("button", { name: "Song" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Vocals" }));
    expect(screen.getByRole("button", { name: "Vocals" })).toHaveAttribute("aria-pressed", "true");
  });

  it("changes the speed, and turns tones on", async () => {
    const user = userEvent.setup();
    const onTones = vi.fn<(tones: boolean) => void>();
    let playback!: ReturnType<typeof createPlayback>;
    render(() => {
      playback = createPlayback({ audio: "a" });
      return <Transport playback={playback} {...rest} onTones={onTones} />;
    });
    await user.click(screen.getByTestId("speed"));
    await user.click(await screen.findByRole("option", { name: "50%" }));
    expect(playback.speed()).toBe(0.5);
    expect(screen.getByTestId("speed")).toHaveTextContent("50%");
    await user.click(screen.getByTestId("tones"));
    expect(onTones).toHaveBeenCalledWith(true);
  });
});
