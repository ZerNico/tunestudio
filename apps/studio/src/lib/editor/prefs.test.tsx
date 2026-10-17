import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it } from "vitest";

import { createEditorPrefs } from "./prefs";

beforeEach(() => localStorage.clear());

describe("editor prefs", () => {
  it("starts following, without tones, at full volume, and remembers changes", () => {
    const first = createRoot(() => createEditorPrefs());
    expect([first.following(), first.tones(), first.volumes()]).toEqual([true, false, { song: 1, tones: 1 }]);
    first.setFollowing(false);
    first.setTones(true);
    first.setVolume("tones", 0.4);
    const again = createRoot(() => createEditorPrefs());
    expect([again.following(), again.tones(), again.volumes()]).toEqual([false, true, { song: 1, tones: 0.4 }]);
  });

  it("shows the sung pitch and waveform at first but not the video, and remembers them", () => {
    const first = createRoot(() => createEditorPrefs());
    expect([first.pitch(), first.waveform(), first.video()]).toEqual([true, true, false]);
    first.setPitch(false);
    first.setWaveform(false);
    first.setVideo(true);
    const again = createRoot(() => createEditorPrefs());
    expect([again.pitch(), again.waveform(), again.video()]).toEqual([false, false, true]);
  });

  it("reads what isn't a setting as the default", () => {
    localStorage.setItem("tunestudio.editor.follow", "maybe");
    localStorage.setItem("tunestudio.editor.volumes", '{"song": 7, "tones": 0.5}');
    const prefs = createRoot(() => createEditorPrefs());
    expect([prefs.following(), prefs.volumes()]).toEqual([true, { song: 1, tones: 0.5 }]);
    localStorage.setItem("tunestudio.editor.volumes", "not json");
    expect(createRoot(() => createEditorPrefs()).volumes()).toEqual({ song: 1, tones: 1 });
  });
});
