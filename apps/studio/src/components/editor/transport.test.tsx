import { fireEvent, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal, flush } from "solid-js";
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
  volumes: { song: 1, tones: 1 },
  onVolume: () => {},
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
    let playback!: ReturnType<typeof createPlayback>;
    render(() => {
      playback = createPlayback({ audio: "a", vocals: "v", instrumental: "i" });
      return <Transport playback={playback} {...rest} />;
    });
    expect(screen.getByRole("button", { name: "Song" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Vocals" }));
    expect(playback.source()).toBe("vocals");
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
    // One source: nothing to switch.
    expect(screen.queryByRole("group", { name: "Listen to" })).toBeNull();
    await user.click(screen.getByTestId("speed"));
    await user.click(await screen.findByRole("option", { name: "0.5×" }));
    expect(playback.speed()).toBe(0.5);
    expect(screen.getByTestId("speed")).toHaveTextContent("0.5×");
    await user.click(screen.getByTestId("tones"));
    expect(onTones).toHaveBeenCalledWith(true);
  });

  it("sets the song's volume, mutes and unmutes, and turns tones on from their volume", async () => {
    const onVolume = vi.fn();
    const [volumes, setVolumes] = createSignal({ song: 0.6, tones: 1 });
    const [tones, setTones] = createSignal(false);
    const onTones = vi.fn((on: boolean) => setTones(on));
    render(() => (
      <Transport
        playback={createPlayback({ audio: "a" })}
        {...rest}
        volumes={volumes()}
        onVolume={(channel, value) => {
          onVolume(channel, value);
          setVolumes({ ...volumes(), [channel]: value });
        }}
        tones={tones()}
        onTones={onTones}
      />
    ));
    // The thumbs' range inputs (hidden until laid out, so found by their names).
    fireEvent.keyDown(screen.getByLabelText("Song volume"), { key: "ArrowLeft" });
    expect(onVolume).toHaveBeenLastCalledWith("song", 0.59);
    flush();
    fireEvent.click(screen.getByTestId("mute"));
    expect(onVolume).toHaveBeenLastCalledWith("song", 0);
    flush();
    fireEvent.click(screen.getByTestId("mute"));
    expect(onVolume).toHaveBeenLastCalledWith("song", 0.59);
    // Tones off: their volume is there, dimmed; moving it turns them on.
    expect(screen.getByTestId("volume-tones")).toHaveAttribute("data-dimmed");
    fireEvent.keyDown(screen.getByLabelText("Tones volume"), { key: "ArrowLeft" });
    expect(onTones).toHaveBeenCalledWith(true);
    expect(onVolume).toHaveBeenLastCalledWith("tones", 0.99);
  });

  it("turns tones off when their volume goes to nothing, and back on at the volume they had", () => {
    const onTones = vi.fn();
    const [volumes, setVolumes] = createSignal({ song: 1, tones: 0.02 });
    const [tones, setTones] = createSignal(true);
    render(() => (
      <Transport
        playback={createPlayback({ audio: "a" })}
        {...rest}
        volumes={volumes()}
        onVolume={(channel, value) => setVolumes({ ...volumes(), [channel]: value })}
        tones={tones()}
        onTones={(on) => {
          onTones(on);
          setTones(on);
        }}
      />
    ));
    const slider = screen.getByLabelText("Tones volume");
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    flush();
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    flush();
    expect(onTones).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId("volume-tones")).toHaveAttribute("data-dimmed");
    fireEvent.click(screen.getByTestId("tones"));
    flush();
    expect(onTones).toHaveBeenLastCalledWith(true);
    expect(screen.getByLabelText("Tones volume")).toHaveAttribute("aria-valuenow", "1");
  });
});
