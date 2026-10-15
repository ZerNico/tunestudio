import { fireEvent, render, screen, within } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import type { ProjectMedia } from "~/lib/native/types";

import type { ArtworkActions } from "./song-artwork";
import { SongFiles } from "./song-files";

const media = (id: number, role: ProjectMedia["role"], fileName: string, mime: string): ProjectMedia => ({
  id,
  role,
  fileName,
  mime,
  size: 4_000_000,
  duration: role === "audio" ? 241 : null,
  url: `media://p/${id}`,
});

function setup() {
  const actions: ArtworkActions = {
    set: vi.fn(async () => {}),
    findCovers: vi.fn(async () => []),
    chooseImage: vi.fn(async () => ({ path: "/picked/back.jpg", preview: "data:," })),
    onError: vi.fn(),
  };
  const onChangeCover = vi.fn();
  render(() => (
    <SongFiles
      media={[media(1, "audio", "mix.mp3", "audio/mpeg"), media(2, "cover", "front.jpg", "image/jpeg")]}
      actions={actions}
      onChangeCover={onChangeCover}
    />
  ));
  return { actions, onChangeCover };
}

describe("song files", () => {
  it("lists every file, and the cover and background even without one", () => {
    setup();
    const rows = within(screen.getByRole("list", { name: "Files" })).getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.testid)).toEqual(["file-audio", "file-cover", "file-background"]);
    expect(screen.getByTestId("file-audio")).toHaveTextContent("Songmix.mp33.8 MB · 4:01");
    expect(screen.getByTestId("file-background")).toHaveTextContent("None");
    // The song's audio can't be changed here.
    expect(within(screen.getByTestId("file-audio")).queryByRole("button")).toBeNull();
  });

  it("changes the cover in its dialog, and the background from a file", async () => {
    const { actions, onChangeCover } = setup();
    fireEvent.click(within(screen.getByTestId("file-cover")).getByRole("button", { name: "Change…" }));
    expect(onChangeCover).toHaveBeenCalled();
    fireEvent.click(within(screen.getByTestId("file-background")).getByRole("button", { name: "Add…" }));
    await vi.waitFor(() =>
      expect(actions.set).toHaveBeenCalledWith("background", { kind: "file", path: "/picked/back.jpg" }),
    );
    fireEvent.click(screen.getByTestId("remove-cover"));
    await vi.waitFor(() => expect(actions.set).toHaveBeenCalledWith("cover", { kind: "none" }));
  });
});
