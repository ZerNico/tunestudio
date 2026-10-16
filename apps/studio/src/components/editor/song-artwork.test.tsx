import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import type { CoverCandidate } from "~/lib/native/types";

import { type ArtworkActions, CoverDialog } from "./song-artwork";

const found: CoverCandidate = {
  url: "https://is1-ssl.mzstatic.com/cover.jpg",
  preview: "data:image/jpeg;base64,AA==",
  source: "itunes",
  release: "single",
  artist: "Test Artist",
  title: "Night Signals",
  album: null,
  year: 2024,
  genre: null,
  confident: true,
};

function setup(overrides: Partial<ArtworkActions> = {}, open = true) {
  const actions: ArtworkActions = {
    set: vi.fn(async () => {}),
    findCovers: vi.fn(async () => [found]),
    chooseImage: vi.fn(async () => ({ path: "/picked/front.jpg", preview: "data:," })),
    onError: vi.fn(),
    ...overrides,
  };
  const [isOpen, setOpen] = createSignal(open);
  render(() => <CoverDialog open={isOpen()} onOpenChange={setOpen} url="media://p/2" actions={actions} />);
  return { actions, isOpen, setOpen };
}

describe("cover dialog", () => {
  it("looks for covers only once it opens", async () => {
    const { actions, setOpen } = setup({}, false);
    expect(actions.findCovers).not.toHaveBeenCalled();
    setOpen(true);
    expect(await screen.findByRole("radio", { name: "The song's cover" })).toBeChecked();
    await vi.waitFor(() => expect(actions.findCovers).toHaveBeenCalledTimes(1));
  });

  it("applies a found cover and closes", async () => {
    const { actions, isOpen } = setup();
    fireEvent.click(await screen.findByRole("radio", { name: /Test Artist, Night Signals \(Apple Music\)/ }));
    await vi.waitFor(() => expect(actions.set).toHaveBeenCalledWith("cover", { kind: "found", url: found.url }));
    await vi.waitFor(() => expect(isOpen()).toBe(false));
  });

  it("says what went wrong and stays open, then takes a picked file", async () => {
    const failure = new Error("Disk full.");
    const set = vi.fn(async () => {});
    set.mockRejectedValueOnce(failure);
    const { actions, isOpen } = setup({ set });
    fireEvent.click(await screen.findByRole("radio", { name: "No cover" }));
    await vi.waitFor(() => expect(actions.onError).toHaveBeenCalledWith("Couldn't change the cover", failure));
    expect(isOpen()).toBe(true);
    // Unticked again, so the same tile can be picked again.
    expect(screen.getByRole("radio", { name: "No cover" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "The song's cover" })).toBeChecked();
    fireEvent.click(screen.getByTestId("cover-choose"));
    await vi.waitFor(() => expect(set).toHaveBeenCalledWith("cover", { kind: "file", path: "/picked/front.jpg" }));
  });
});
