import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type { ImportProgress, ProjectMedia } from "~/lib/native/types";

import type { ArtworkActions } from "./song-artwork";
import { type MediaActions, SongFiles } from "./song-files";

const media = (id: number, role: ProjectMedia["role"], fileName: string, mime: string): ProjectMedia => ({
  id,
  role,
  fileName,
  mime,
  size: 4_000_000,
  duration: role === "audio" ? 241 : null,
  url: `media://p/${id}`,
});

const FILES = [
  media(1, "audio", "mix.mp3", "audio/mpeg"),
  media(2, "vocals", "mix [VOC].m4a", "audio/mp4"),
  media(3, "instrumental", "mix [INSTR].m4a", "audio/mp4"),
  media(4, "cover", "front.jpg", "image/jpeg"),
];

function setup(files: ProjectMedia[] = FILES) {
  const actions: ArtworkActions = {
    set: vi.fn(async () => {}),
    findCovers: vi.fn(async () => []),
    chooseImage: vi.fn(async () => ({ path: "/picked/back.jpg", preview: "data:," })),
    onError: vi.fn(),
  };
  const [separating, setSeparating] = createSignal<ImportProgress | null | undefined>(undefined);
  const songMedia: MediaActions = {
    chooseFile: vi.fn(async (kind: "audio" | "video") => (kind === "audio" ? "/picked/new.flac" : "/picked/clip.mp4")),
    replace: vi.fn(async () => {}),
    removeVideo: vi.fn(async () => {}),
    separating,
    separate: vi.fn(() => setSeparating({ step: "Separating the voice", done: 40, total: 100, unit: "percent" })),
    stopSeparating: vi.fn(() => setSeparating(undefined)),
    onError: vi.fn(),
  };
  const onChangeCover = vi.fn();
  render(() => <SongFiles media={files} actions={actions} songMedia={songMedia} onChangeCover={onChangeCover} />);
  return { actions, songMedia, onChangeCover };
}

describe("song files", () => {
  it("lists every file, and the video, cover and background even without one", () => {
    setup();
    const rows = within(screen.getByRole("list", { name: "Files" })).getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "file-audio",
      "file-vocals",
      "file-instrumental",
      "file-video",
      "file-cover",
      "file-background",
    ]);
    expect(screen.getByTestId("file-audio")).toHaveTextContent("Songmix.mp33.8 MB · 4:01");
    expect(screen.getByTestId("file-background")).toHaveTextContent("None");
    // The song, vocals and music are only replaced, never removed.
    expect(
      within(screen.getByTestId("file-vocals"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Replace"]);
  });

  it("changes the cover in its dialog, and the background from a file", async () => {
    const { actions, onChangeCover } = setup();
    fireEvent.click(within(screen.getByTestId("file-cover")).getByRole("button", { name: "Change" }));
    expect(onChangeCover).toHaveBeenCalled();
    fireEvent.click(within(screen.getByTestId("file-background")).getByRole("button", { name: "Add" }));
    await vi.waitFor(() =>
      expect(actions.set).toHaveBeenCalledWith("background", { kind: "file", path: "/picked/back.jpg" }),
    );
    fireEvent.click(screen.getByTestId("remove-cover"));
    await vi.waitFor(() => expect(actions.set).toHaveBeenCalledWith("cover", { kind: "none" }));
  });

  it("replaces the song, then asks whether to separate the voice from it again", async () => {
    const { songMedia } = setup();
    fireEvent.click(screen.getByTestId("replace-audio"));
    await vi.waitFor(() => expect(songMedia.replace).toHaveBeenCalledWith("audio", "/picked/new.flac"));
    expect(songMedia.chooseFile).toHaveBeenCalledWith("audio");
    fireEvent.click(await screen.findByTestId("separate-new-song"));
    expect(songMedia.separate).toHaveBeenCalledOnce();
    expect(await screen.findByTestId("separating")).toHaveTextContent("Separating the voice…");
    // While it separates, nothing else is replaced.
    expect(screen.getByTestId("replace-vocals")).toBeDisabled();
    fireEvent.click(screen.getByTestId("stop-separating"));
    expect(await screen.findByTestId("separate-again")).toBeInTheDocument();
  });

  it("adds a video, and removes it", async () => {
    const { songMedia } = setup();
    fireEvent.click(screen.getByTestId("replace-video"));
    await vi.waitFor(() => expect(songMedia.replace).toHaveBeenCalledWith("video", "/picked/clip.mp4"));
    expect(screen.queryByTestId("separate-question")).not.toBeInTheDocument();
    cleanup();
    const withVideo = setup([...FILES, media(5, "video", "clip.mp4", "video/mp4")]);
    expect(screen.getByTestId("replace-video")).toHaveTextContent("Replace");
    fireEvent.click(screen.getByTestId("remove-video"));
    await vi.waitFor(() => expect(withVideo.songMedia.removeVideo).toHaveBeenCalledOnce());
  });
});
